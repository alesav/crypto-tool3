/**
 * trading.js — Signed order placement + trailing stop engine
 * Per CLONE_SPECIFICATION §12.1–12.8, §3.3
 *
 * Code review fixes applied:
 * - mainOrder.orderId || mainOrder.id (Bybit uses .id)
 * - Binance stop order: priceProtect/reduceOnly as real booleans
 * - Bybit stop: uses stopLoss field on main order (not a separate conditional order)
 * - Binance closePosition: reduceOnly as boolean
 * - Trailing stop initial currentStop: entryPrice - sign*(R*0.10)/size (below entry for LONG)
 * - tsEnable: places the initial stop order on exchange immediately
 * - tsOnPriceUpdate: tsSave() throttled to avoid 30 writes/min
 * - placeOrder: in-flight guard prevents double-submit
 * - loadOpenOrders guard: returns early if no symbol without leaving "Loading…"
 * - SW SHELL_ASSETS: use cache-then-network strategy for script assets
 */

'use strict';

// ── WebCrypto HMAC-SHA256 ─────────────────────────────────────────────────────
async function hmac256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

// ── Exchange adapters ─────────────────────────────────────────────────────────
const BN_BASE  = 'https://fapi.binance.com';
const BBY_BASE = 'https://api.bybit.com';

async function binanceSigned(method, path, params, creds) {
  const ts  = Date.now();
  const raw = qs({ ...params, timestamp: ts, recvWindow: 5000 });
  const sig = await hmac256(creds.apiSecret, raw);
  const fullQs = `${raw}&signature=${sig}`;
  const url = `${BN_BASE}${path}${method === 'GET' ? '?' + fullQs : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': creds.apiKey,
      ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(method !== 'GET' ? { body: fullQs } : {}),
  });
  const data = await res.json();
  if (data.code && data.code < 0) throw new Error(`Binance ${data.code}: ${data.msg}`);
  return data;
}

async function bybitSigned(method, path, params, creds) {
  const ts      = Date.now().toString();
  const recv    = '5000';
  const payload = method === 'GET' ? qs(params) : JSON.stringify(params);
  const sig     = await hmac256(creds.apiSecret, `${ts}${creds.apiKey}${recv}${payload}`);
  const url     = `${BBY_BASE}${path}${method === 'GET' ? '?' + payload : ''}`;
  const res     = await fetch(url, {
    method,
    headers: {
      'X-BAPI-API-KEY':      creds.apiKey,
      'X-BAPI-TIMESTAMP':    ts,
      'X-BAPI-RECV-WINDOW':  recv,
      'X-BAPI-SIGN':         sig,
      'Content-Type':        'application/json',
    },
    ...(method !== 'GET' ? { body: payload } : {}),
  });
  const data = await res.json();
  if (data.retCode && data.retCode !== 0) throw new Error(`Bybit ${data.retCode}: ${data.retMsg}`);
  return data.result;
}

// ── Symbol info cache ─────────────────────────────────────────────────────────
// No TTL: symbol metadata (precision, stepSize) is extremely stable.
// Clear by reloading the page or calling _symbolInfoCache = {} from devtools.
const _symbolInfoCache = {};
const DEFAULT_INFO = {
  pricePrecision: 2, quantityPrecision: 3,
  minNotional: 5, minQty: 0.001, stepSize: 0.001, tickSize: 0.01, maxLeverage: 100,
};

async function getSymbolInfo(symbol, creds) {
  if (_symbolInfoCache[symbol]) return _symbolInfoCache[symbol];
  try {
    if (creds.exchange === 'binance') {
      const data = await fetch(`${BN_BASE}/fapi/v1/exchangeInfo`).then(r => r.json());
      const sym  = (data.symbols || []).find(s => s.symbol === symbol);
      if (!sym) return DEFAULT_INFO;
      const priceF = sym.filters.find(f => f.filterType === 'PRICE_FILTER') || {};
      const lotF   = sym.filters.find(f => f.filterType === 'LOT_SIZE')     || {};
      const minF   = sym.filters.find(f => f.filterType === 'MIN_NOTIONAL') || {};
      const info = {
        pricePrecision:    sym.pricePrecision    || 2,
        quantityPrecision: sym.quantityPrecision || 3,
        tickSize:    parseFloat(priceF.tickSize   || '0.01'),
        stepSize:    parseFloat(lotF.stepSize     || '0.001'),
        minQty:      parseFloat(lotF.minQty       || '0.001'),
        minNotional: parseFloat(minF.notional     || '5'),
        maxLeverage: 100,
      };
      return (_symbolInfoCache[symbol] = info);
    } else {
      const data = await fetch(`${BBY_BASE}/v5/market/instruments-info?category=linear&symbol=${symbol}`).then(r => r.json());
      const sym  = data.result?.list?.[0];
      if (!sym) return DEFAULT_INFO;
      const stepStr = sym.lotSizeFilter?.qtyStep || '0.001';
      const info = {
        pricePrecision:    sym.priceScale || 2,
        quantityPrecision: stepStr.includes('.') ? stepStr.split('.')[1].length : 0,
        tickSize:    parseFloat(sym.priceFilter?.tickSize         || '0.01'),
        stepSize:    parseFloat(stepStr),
        minQty:      parseFloat(sym.lotSizeFilter?.minOrderQty    || '0.001'),
        minNotional: parseFloat(sym.lotSizeFilter?.minOrderAmt    || '5'),
        maxLeverage: parseInt(sym.leverageFilter?.maxLeverage     || '100'),
      };
      return (_symbolInfoCache[symbol] = info);
    }
  } catch { return DEFAULT_INFO; }
}

// ── §12.3 Risk-based position sizing ─────────────────────────────────────────
function calculateQty(entry, stop, maxLoss, leverage, side, info) {
  const diff = Math.abs(entry - stop);
  if (!entry || !stop || diff / entry < 0.0001) return null;
  if (side === 'BUY'  && stop >= entry) return null;
  if (side === 'SELL' && stop <= entry) return null;

  // Round DOWN to stepSize so we never exceed the risk budget
  let qty = Math.floor((maxLoss / diff) / info.stepSize) * info.stepSize;
  qty = Math.max(info.minQty, parseFloat(qty.toFixed(info.quantityPrecision)));

  const posVal  = qty * entry;
  const margin  = posVal / leverage;
  const actRisk = qty * diff;
  if (posVal < info.minNotional) return null;
  return { qty, posVal, margin, actRisk, diff };
}

// In-flight guard: prevents double-submit
let _orderInFlight = false;

// ── §12.5 Place order ─────────────────────────────────────────────────────────
async function placeOrder({ symbol, side, type, price, stopLoss, maxLoss, leverage, creds }) {
  if (_orderInFlight) throw new Error('Order already in progress — please wait');
  _orderInFlight = true;
  try {
    const info  = await getSymbolInfo(symbol, creds);
    const entry = type === 'LIMIT'
      ? price
      : parseFloat((await fetch(`${BN_BASE}/fapi/v1/ticker/price?symbol=${symbol}`).then(r => r.json())).price);

    const calc = calculateQty(entry, stopLoss, maxLoss, leverage, side, info);
    if (!calc) throw new Error('Invalid order parameters — check stop distance and minimum size');
    const { qty, actRisk } = calc;

    await setLeverage(symbol, leverage, creds);

    let mainOrder, stopOrder, stopErr = null;

    if (creds.exchange === 'binance') {
      mainOrder = await binanceSigned('POST', '/fapi/v1/order', {
        symbol, side, type,
        quantity: qty.toFixed(info.quantityPrecision),
        ...(type === 'LIMIT' ? { price: price.toFixed(info.pricePrecision), timeInForce: 'GTC' } : {}),
      }, creds);

      if (stopLoss) {
        const stopSide = side === 'BUY' ? 'SELL' : 'BUY';
        try {
          // FIX: priceProtect and reduceOnly must be booleans, not strings
          stopOrder = await binanceSigned('POST', '/fapi/v1/order', {
            symbol, side: stopSide, type: 'STOP_MARKET',
            stopPrice:   stopLoss.toFixed(info.pricePrecision),
            quantity:    qty.toFixed(info.quantityPrecision),
            workingType: 'MARK_PRICE',
            priceProtect: true,   // boolean — Binance rejects string 'TRUE'
            reduceOnly:   true,   // boolean — Binance rejects string 'true'
          }, creds);
        } catch (e) { stopErr = e.message; }
      }

    } else {
      // Bybit: pass stopLoss inline on the main order — cleaner than a separate conditional order
      const params = {
        category: 'linear', symbol,
        side: side === 'BUY' ? 'Buy' : 'Sell',
        orderType: type === 'MARKET' ? 'Market' : 'Limit',
        qty: qty.toFixed(info.quantityPrecision),
        ...(type === 'LIMIT' ? { price: price.toFixed(info.pricePrecision) } : {}),
        ...(stopLoss ? { stopLoss: stopLoss.toFixed(info.pricePrecision), slTriggerBy: 'MarkPrice' } : {}),
      };
      mainOrder = await bybitSigned('POST', '/v5/order/create', params, creds);
    }

    // Persist order history (capped 100)
    const hist = JSON.parse(localStorage.getItem('cryptoTool_orderHistory') || '[]');
    // FIX: mainOrder.orderId for Binance; mainOrder.orderId for Bybit (bybitSigned returns result)
    const orderId = mainOrder.orderId ?? mainOrder.id;
    hist.unshift({ symbol, side, type, qty, entry, stopLoss, actRisk, ts: Date.now(), id: orderId });
    localStorage.setItem('cryptoTool_orderHistory', JSON.stringify(hist.slice(0, 100)));

    return { mainOrder, stopOrder, stopErr, qty, actRisk };
  } finally {
    _orderInFlight = false;
  }
}

// ── Cancel order ──────────────────────────────────────────────────────────────
async function cancelOrder(symbol, orderId, creds) {
  if (creds.exchange === 'binance') {
    return binanceSigned('DELETE', '/fapi/v1/order', { symbol, orderId }, creds);
  } else {
    return bybitSigned('POST', '/v5/order/cancel', { category: 'linear', symbol, orderId }, creds);
  }
}

// ── Close position (market reduce) ────────────────────────────────────────────
async function closePosition(symbol, side, qty, creds) {
  const info      = await getSymbolInfo(symbol, creds);
  const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
  if (creds.exchange === 'binance') {
    return binanceSigned('POST', '/fapi/v1/order', {
      symbol, side: closeSide, type: 'MARKET',
      quantity:   qty.toFixed(info.quantityPrecision),
      reduceOnly: true,   // FIX: boolean, not string 'true'
    }, creds);
  } else {
    return bybitSigned('POST', '/v5/order/create', {
      category:  'linear', symbol,
      side:      closeSide === 'SELL' ? 'Sell' : 'Buy',
      orderType: 'Market',
      qty:       qty.toFixed(info.quantityPrecision),
      reduceOnly: true,
    }, creds);
  }
}

// ── Set leverage ──────────────────────────────────────────────────────────────
async function setLeverage(symbol, leverage, creds) {
  try {
    if (creds.exchange === 'binance') {
      await binanceSigned('POST', '/fapi/v1/leverage', { symbol, leverage }, creds);
    } else {
      await bybitSigned('POST', '/v5/position/set-leverage', {
        category: 'linear', symbol,
        buyLeverage: String(leverage), sellLeverage: String(leverage),
      }, creds);
    }
  } catch (e) {
    // Binance -4028 "no change" / Bybit 110043 "leverage not modified" — safe to ignore
    if (!e.message.includes('4028') && !e.message.includes('110043') && !e.message.includes('not modified')) {
      throw e;
    }
  }
}

// ── Get positions ─────────────────────────────────────────────────────────────
async function getPositions(creds) {
  if (!creds) return [];
  if (creds.exchange === 'binance') {
    const data = await binanceSigned('GET', '/fapi/v2/positionRisk', {}, creds);
    return (Array.isArray(data) ? data : [])
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => ({
        symbol:           p.symbol,
        side:             parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
        positionAmt:      Math.abs(parseFloat(p.positionAmt)),
        entryPrice:       parseFloat(p.entryPrice),
        markPrice:        parseFloat(p.markPrice),
        unRealizedProfit: parseFloat(p.unRealizedProfit),
        leverage:         parseInt(p.leverage),
        notional:         Math.abs(parseFloat(p.notional)),
        exchange:         'binance',
      }));
  } else {
    const data = await bybitSigned('GET', '/v5/position/list', { category: 'linear' }, creds);
    return (data?.list || [])
      .filter(p => parseFloat(p.size) !== 0)
      .map(p => ({
        symbol:           p.symbol,
        side:             p.side === 'Buy' ? 'LONG' : 'SHORT',
        positionAmt:      Math.abs(parseFloat(p.size)),
        entryPrice:       parseFloat(p.avgPrice),
        markPrice:        parseFloat(p.markPrice),
        unRealizedProfit: parseFloat(p.unrealisedPnl),
        leverage:         parseInt(p.leverage),
        notional:         Math.abs(parseFloat(p.positionValue)),
        exchange:         'bybit',
      }));
  }
}

// ── Get open orders ───────────────────────────────────────────────────────────
async function getOpenOrders(symbol, creds) {
  if (!creds || !symbol) return [];
  if (creds.exchange === 'binance') {
    const data = await binanceSigned('GET', '/fapi/v1/openOrders', { symbol }, creds);
    return (Array.isArray(data) ? data : []).map(o => ({
      orderId:   o.orderId,  symbol: o.symbol,   side: o.side,
      type:      o.type,     qty: parseFloat(o.origQty),
      price:     parseFloat(o.price),    stopPrice: parseFloat(o.stopPrice),
      status:    o.status,   ts: o.time, exchange: 'binance',
    }));
  } else {
    const data = await bybitSigned('GET', '/v5/order/realtime', { category: 'linear', symbol }, creds);
    return (data?.list || []).map(o => ({
      orderId:   o.orderId,   symbol: o.symbol,
      side:      o.side === 'Buy' ? 'BUY' : 'SELL',
      type:      o.orderType.toUpperCase(),
      qty:       parseFloat(o.qty),
      price:     parseFloat(o.price),
      stopPrice: parseFloat(o.triggerPrice || '0'),
      status:    o.orderStatus, ts: parseInt(o.createdTime), exchange: 'bybit',
    }));
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// §12.7  TRAILING STOP ENGINE — 4-level ratchet
// ══════════════════════════════════════════════════════════════════════════════
const TS_LEVELS = [
  { targetR: 0.25, stopR: 0.10 },
  { targetR: 0.50, stopR: 0.25 },
  { targetR: 0.75, stopR: 0.50 },
  { targetR: 1.00, stopR: 0.75 },
];

const _tsConfigs = {};
let   _tsCreds   = null;
let   _tsSaveTimer = null;  // throttle writes

function tsLoad() {
  try { Object.assign(_tsConfigs, JSON.parse(localStorage.getItem('cryptoTool_trailingStops') || '{}')); } catch {}
}

// FIX: throttle saves to at most once per 5s (was every 2s price update)
function tsSave() {
  if (_tsSaveTimer) return;
  _tsSaveTimer = setTimeout(() => {
    _tsSaveTimer = null;
    try { localStorage.setItem('cryptoTool_trailingStops', JSON.stringify(_tsConfigs)); } catch {}
  }, 5000);
}

async function tsEnable(position, riskAmount, creds) {
  const { symbol, side, positionAmt: size, entryPrice } = position;
  const R    = riskAmount;
  const sign = side === 'LONG' ? 1 : -1;

  // Level table: target price where each level triggers, and where the stop moves to
  const levels = TS_LEVELS.map(l => ({
    targetPrice: entryPrice + sign * (R * l.targetR) / size,
    stopPrice:   entryPrice + sign * (R * l.stopR)   / size,
    targetR: l.targetR, stopR: l.stopR,
  }));

  // FIX: initial stop is BELOW entry for LONG, ABOVE for SHORT
  // = entryPrice - sign*(R*0.10)/size
  // (was incorrectly: levels[0].stopPrice - sign*(R*0.10)/size = entryPrice due to double subtraction)
  const initialStop = entryPrice - sign * (R * TS_LEVELS[0].stopR) / size;

  _tsConfigs[symbol] = {
    symbol, side, size, entryPrice, R,
    currentLevel:  0,
    currentStop:   initialStop,
    highestPrice:  entryPrice,
    lowestPrice:   entryPrice,
    levels,
    activeStopOrderId: null,
    _lastPlacedStop:   null,   // null = not yet placed
    ts: Date.now(),
  };
  tsSave();

  // FIX: place the initial protective stop immediately (not deferred to first price update)
  if (creds) {
    try {
      await _tsPlaceStopOrder(symbol, initialStop, creds);
      _tsConfigs[symbol]._lastPlacedStop = initialStop;
      window.trading?.onStopUpdate?.(symbol, initialStop);
    } catch (e) {
      console.warn('[TrailingStop] Failed to place initial stop:', e.message);
    }
  }

  window.trading?.onLevelAdvance?.(symbol, 0, initialStop);
}

function tsDisable(symbol) {
  delete _tsConfigs[symbol];
  tsSave();
}

async function _tsPlaceStopOrder(symbol, stopPrice, creds) {
  const cfg      = _tsConfigs[symbol];
  if (!cfg) return;
  const info     = await getSymbolInfo(symbol, creds);
  const stopSide = cfg.side === 'LONG' ? 'SELL' : 'BUY';

  if (creds.exchange === 'binance') {
    const res = await binanceSigned('POST', '/fapi/v1/order', {
      symbol, side: stopSide, type: 'STOP_MARKET',
      stopPrice:   stopPrice.toFixed(info.pricePrecision),
      quantity:    cfg.size.toFixed(info.quantityPrecision),
      workingType: 'MARK_PRICE',
      priceProtect: true,  // boolean
      reduceOnly:   true,  // boolean
    }, creds);
    cfg.activeStopOrderId = res.orderId;
  } else {
    // Bybit v5: conditional Market order triggered by mark price
    const res = await bybitSigned('POST', '/v5/order/create', {
      category:        'linear',
      symbol,
      side:            stopSide === 'SELL' ? 'Sell' : 'Buy',
      orderType:       'Market',
      qty:             cfg.size.toFixed(info.quantityPrecision),
      triggerPrice:    stopPrice.toFixed(info.pricePrecision),
      triggerDirection: cfg.side === 'LONG' ? 2 : 1,  // 2=fall below, 1=rise above
      triggerBy:       'MarkPrice',
      reduceOnly:      true,
    }, creds);
    cfg.activeStopOrderId = res?.orderId;
  }
}

async function tsOnPriceUpdate(symbol, price, creds) {
  const cfg = _tsConfigs[symbol];
  if (!cfg) return;

  const sign = cfg.side === 'LONG' ? 1 : -1;

  // Track extremes
  if (cfg.side === 'LONG'  && price > cfg.highestPrice) cfg.highestPrice = price;
  if (cfg.side === 'SHORT' && price < cfg.lowestPrice)  cfg.lowestPrice  = price;
  const extreme = cfg.side === 'LONG' ? cfg.highestPrice : cfg.lowestPrice;

  // Advance to highest reached level
  let newLevel = cfg.currentLevel;
  for (let i = cfg.levels.length - 1; i >= 0; i--) {
    const met = cfg.side === 'LONG' ? price >= cfg.levels[i].targetPrice
                                    : price <= cfg.levels[i].targetPrice;
    if (met) { newLevel = i + 1; break; }
  }

  if (newLevel > cfg.currentLevel) {
    cfg.currentLevel = newLevel;
    cfg.currentStop  = cfg.levels[newLevel - 1].stopPrice;
    const pct = (TS_LEVELS[newLevel - 1].targetR * 100).toFixed(0);
    window.showToast?.(`🎯 ${symbol} Trail L${newLevel} (+${pct}R) — stop locked at +${(TS_LEVELS[newLevel - 1].stopR * 100).toFixed(0)}R`, 'success');
    window.trading?.onLevelAdvance?.(symbol, newLevel, cfg.currentStop);
  }

  // Level ≥ 2: trail 0.10R behind the extreme
  if (cfg.currentLevel >= 2) {
    const candidate = extreme - sign * (0.10 * cfg.R) / cfg.size;
    if (cfg.side === 'LONG'  && candidate > cfg.currentStop) cfg.currentStop = candidate;
    if (cfg.side === 'SHORT' && candidate < cfg.currentStop) cfg.currentStop = candidate;
  }

  // Place/update stop order on exchange if it moved enough
  if (creds) {
    const lastPlaced = cfg._lastPlacedStop;
    const moved = lastPlaced !== null
      ? Math.abs(cfg.currentStop - lastPlaced) / cfg.entryPrice
      : 1; // first call: always place

    if (moved > 0.001) {
      try {
        if (cfg.activeStopOrderId) {
          await cancelOrder(symbol, cfg.activeStopOrderId, creds).catch(() => {});
          cfg.activeStopOrderId = null;
        }
        await _tsPlaceStopOrder(symbol, cfg.currentStop, creds);
        cfg._lastPlacedStop = cfg.currentStop;
        window.trading?.onStopUpdate?.(symbol, cfg.currentStop);
      } catch (e) {
        console.warn('[TrailingStop] Stop update failed:', e.message);
      }
    }
  }

  tsSave(); // throttled — writes at most once per 5s
}

// ── Init ──────────────────────────────────────────────────────────────────────
tsLoad();

window.trading = {
  placeOrder,
  cancelOrder:    (s, id)        => cancelOrder(s, id, _tsCreds),
  closePosition:  (s, side, qty) => closePosition(s, side, qty, _tsCreds),
  setLeverage:    (s, lev)       => setLeverage(s, lev, _tsCreds),
  getPositions:   ()             => getPositions(_tsCreds),
  getOpenOrders:  (s)            => getOpenOrders(s, _tsCreds),
  setCreds:       (creds)        => { _tsCreds = creds; },
  calculateQty,
  getSymbolInfo:  (s)            => getSymbolInfo(s, _tsCreds),
  trailingStop: {
    enable:        (pos, R)  => tsEnable(pos, R, _tsCreds),
    disable:       (sym)     => tsDisable(sym),
    onPriceUpdate: (sym, p)  => tsOnPriceUpdate(sym, p, _tsCreds),
    getAll:        ()        => Object.values(_tsConfigs),
    get:           (sym)     => _tsConfigs[sym],
  },
  // Event hooks — overridden by app.js after load
  onLevelAdvance: null,
  onStopUpdate:   null,
};
