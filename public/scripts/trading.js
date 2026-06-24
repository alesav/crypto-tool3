/**
 * trading.js — Signed order placement + trailing stop engine
 * Per CLONE_SPECIFICATION §12.1–12.8, §3.3
 *
 * Exports via window.trading:
 *   placeOrder(params) → Promise<result>
 *   cancelOrder(symbol, orderId) → Promise
 *   closePosition(symbol, side, qty) → Promise
 *   setLeverage(symbol, leverage) → Promise
 *   getPositions() → Promise<Position[]>
 *   getOpenOrders(symbol) → Promise<Order[]>
 *   trailingStop.enable(position, riskAmount) → void
 *   trailingStop.onPriceUpdate(symbol, price) → void
 *   trailingStop.disable(symbol) → void
 *   trailingStop.getAll() → TrailingStopConfig[]
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
  return Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

// ── Exchange adapters ─────────────────────────────────────────────────────────
const BN_BASE  = 'https://fapi.binance.com';
const BBY_BASE = 'https://api.bybit.com';

async function binanceSigned(method, path, params, creds) {
  const ts  = Date.now();
  const raw = qs({ ...params, timestamp: ts, recvWindow: 5000 });
  const sig = await hmac256(creds.apiSecret, raw);
  const url = `${BN_BASE}${path}?${raw}&signature=${sig}`;
  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': creds.apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    ...(method !== 'GET' ? { body: `${raw}&signature=${sig}` } : {}),
  });
  const data = await res.json();
  if (data.code && data.code < 0) throw new Error(`Binance ${data.code}: ${data.msg}`);
  return data;
}

async function bybitSigned(method, path, params, creds) {
  const ts   = Date.now().toString();
  const recv = '5000';
  const payload = method === 'GET' ? qs(params) : JSON.stringify(params);
  const msg  = `${ts}${creds.apiKey}${recv}${payload}`;
  const sig  = await hmac256(creds.apiSecret, msg);
  const url  = `${BBY_BASE}${path}${method === 'GET' ? '?' + payload : ''}`;
  const res  = await fetch(url, {
    method,
    headers: {
      'X-BAPI-API-KEY': creds.apiKey, 'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': recv, 'X-BAPI-SIGN': sig,
      'Content-Type': 'application/json',
    },
    ...(method !== 'GET' ? { body: payload } : {}),
  });
  const data = await res.json();
  if (data.retCode && data.retCode !== 0) throw new Error(`Bybit ${data.retCode}: ${data.retMsg}`);
  return data.result;
}

// ── Symbol info cache ─────────────────────────────────────────────────────────
const _symbolInfoCache = {};
const DEFAULT_INFO = { pricePrecision: 2, quantityPrecision: 3, minNotional: 5, minQty: 0.001, stepSize: 0.001, tickSize: 0.01, maxLeverage: 100 };

async function getSymbolInfo(symbol, creds) {
  if (_symbolInfoCache[symbol]) return _symbolInfoCache[symbol];
  try {
    if (creds.exchange === 'binance') {
      const data = await fetch(`${BN_BASE}/fapi/v1/exchangeInfo`).then(r => r.json());
      const sym  = (data.symbols || []).find(s => s.symbol === symbol);
      if (!sym) return DEFAULT_INFO;
      const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER') || {};
      const lotFilter   = sym.filters.find(f => f.filterType === 'LOT_SIZE')     || {};
      const minFilter   = sym.filters.find(f => f.filterType === 'MIN_NOTIONAL') || {};
      const info = {
        pricePrecision:    sym.pricePrecision    || 2,
        quantityPrecision: sym.quantityPrecision || 3,
        tickSize:    parseFloat(priceFilter.tickSize  || '0.01'),
        stepSize:    parseFloat(lotFilter.stepSize    || '0.001'),
        minQty:      parseFloat(lotFilter.minQty      || '0.001'),
        minNotional: parseFloat(minFilter.notional    || '5'),
        maxLeverage: 100,
      };
      _symbolInfoCache[symbol] = info;
      return info;
    } else {
      const data = await fetch(`${BBY_BASE}/v5/market/instruments-info?category=linear&symbol=${symbol}`).then(r => r.json());
      const sym  = data.result?.list?.[0];
      if (!sym) return DEFAULT_INFO;
      const info = {
        pricePrecision:    sym.priceScale       || 2,
        quantityPrecision: sym.lotSizeFilter?.qtyStep?.split('.')[1]?.length || 3,
        tickSize:    parseFloat(sym.priceFilter?.tickSize   || '0.01'),
        stepSize:    parseFloat(sym.lotSizeFilter?.qtyStep  || '0.001'),
        minQty:      parseFloat(sym.lotSizeFilter?.minOrderQty || '0.001'),
        minNotional: parseFloat(sym.lotSizeFilter?.minOrderAmt || '5'),
        maxLeverage: parseInt(sym.leverageFilter?.maxLeverage   || '100'),
      };
      _symbolInfoCache[symbol] = info;
      return info;
    }
  } catch { return DEFAULT_INFO; }
}

// ── §12.3 Risk-based position sizing ─────────────────────────────────────────
function calculateQty(entry, stop, maxLoss, leverage, side, info) {
  const diff = Math.abs(entry - stop);
  if (diff / entry < 0.0001) return null;
  if (side === 'BUY'  && stop >= entry) return null;
  if (side === 'SELL' && stop <= entry) return null;

  let qty = maxLoss / diff;
  // Round down to stepSize
  qty = Math.floor(qty / info.stepSize) * info.stepSize;
  qty = Math.max(info.minQty, qty);
  qty = parseFloat(qty.toFixed(info.quantityPrecision));

  const posVal  = qty * entry;
  const margin  = posVal / leverage;
  const actRisk = qty * diff;
  if (posVal < info.minNotional) return null;
  return { qty, posVal, margin, actRisk, diff };
}

// ── §12.5 Place order ─────────────────────────────────────────────────────────
async function placeOrder({ symbol, side, type, price, stopLoss, maxLoss, leverage, creds }) {
  const info   = await getSymbolInfo(symbol, creds);
  const entry  = type === 'LIMIT' ? price : parseFloat((await fetch(`${BN_BASE}/fapi/v1/ticker/price?symbol=${symbol}`).then(r => r.json())).price);
  const calc   = calculateQty(entry, stopLoss, maxLoss, leverage, side, info);
  if (!calc) throw new Error('Invalid order parameters — check stop distance and min size');

  const { qty, actRisk } = calc;

  // 1. Set leverage
  await setLeverage(symbol, leverage, creds);

  let mainOrder, stopOrder, stopErr = null;

  if (creds.exchange === 'binance') {
    const orderParams = {
      symbol, side, type,
      quantity: qty.toFixed(info.quantityPrecision),
      ...(type === 'LIMIT' ? { price: price.toFixed(info.pricePrecision), timeInForce: 'GTC' } : {}),
    };
    mainOrder = await binanceSigned('POST', '/fapi/v1/order', orderParams, creds);

    // Place protective stop
    if (stopLoss) {
      const stopSide = side === 'BUY' ? 'SELL' : 'BUY';
      try {
        stopOrder = await binanceSigned('POST', '/fapi/v1/order', {
          symbol, side: stopSide, type: 'STOP_MARKET',
          stopPrice:    stopLoss.toFixed(info.pricePrecision),
          quantity:     qty.toFixed(info.quantityPrecision),
          workingType: 'MARK_PRICE', priceProtect: 'TRUE', reduceOnly: 'true',
        }, creds);
      } catch (e) { stopErr = e.message; }
    }
  } else {
    // Bybit
    const orderParams = {
      category: 'linear', symbol, side, orderType: type === 'MARKET' ? 'Market' : 'Limit',
      qty: qty.toFixed(info.quantityPrecision),
      ...(type === 'LIMIT' ? { price: price.toFixed(info.pricePrecision) } : {}),
      stopLoss: stopLoss ? stopLoss.toFixed(info.pricePrecision) : undefined,
      slTriggerBy: 'MarkPrice',
    };
    Object.keys(orderParams).forEach(k => orderParams[k] === undefined && delete orderParams[k]);
    mainOrder = await bybitSigned('POST', '/v5/order/create', orderParams, creds);
  }

  // Persist to order history (capped at 100)
  const hist = JSON.parse(localStorage.getItem('cryptoTool_orderHistory') || '[]');
  hist.unshift({ symbol, side, type, qty, entry, stopLoss, actRisk, ts: Date.now(), id: mainOrder.orderId || mainOrder.orderId });
  localStorage.setItem('cryptoTool_orderHistory', JSON.stringify(hist.slice(0, 100)));

  return { mainOrder, stopOrder, stopErr, qty, actRisk };
}

// ── Cancel order ──────────────────────────────────────────────────────────────
async function cancelOrder(symbol, orderId, creds) {
  if (creds.exchange === 'binance') {
    return binanceSigned('DELETE', '/fapi/v1/order', { symbol, orderId }, creds);
  } else {
    return bybitSigned('POST', '/v5/order/cancel', { category: 'linear', symbol, orderId }, creds);
  }
}

// ── Close position ────────────────────────────────────────────────────────────
async function closePosition(symbol, side, qty, creds) {
  const info       = await getSymbolInfo(symbol, creds);
  const closeSide  = side === 'LONG' ? 'SELL' : 'BUY';
  if (creds.exchange === 'binance') {
    return binanceSigned('POST', '/fapi/v1/order', {
      symbol, side: closeSide, type: 'MARKET',
      quantity: qty.toFixed(info.quantityPrecision), reduceOnly: 'true',
    }, creds);
  } else {
    return bybitSigned('POST', '/v5/order/create', {
      category: 'linear', symbol, side: closeSide,
      orderType: 'Market', qty: qty.toFixed(info.quantityPrecision), reduceOnly: true,
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
    // Leverage already set to this value → ignore "no change" errors
    if (!e.message.includes('leverage not modified') && !e.message.includes('110043')) throw e;
  }
}

// ── Get positions ─────────────────────────────────────────────────────────────
async function getPositions(creds) {
  if (creds.exchange === 'binance') {
    const data = await binanceSigned('GET', '/fapi/v2/positionRisk', {}, creds);
    return (Array.isArray(data) ? data : [])
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => ({
        symbol: p.symbol,
        side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
        positionAmt: Math.abs(parseFloat(p.positionAmt)),
        entryPrice: parseFloat(p.entryPrice),
        markPrice: parseFloat(p.markPrice),
        unRealizedProfit: parseFloat(p.unRealizedProfit),
        leverage: parseInt(p.leverage),
        notional: Math.abs(parseFloat(p.notional)),
        exchange: 'binance',
      }));
  } else {
    const data = await bybitSigned('GET', '/v5/position/list', { category: 'linear' }, creds);
    return (data?.list || [])
      .filter(p => parseFloat(p.size) !== 0)
      .map(p => ({
        symbol: p.symbol,
        side: p.side === 'Buy' ? 'LONG' : 'SHORT',
        positionAmt: Math.abs(parseFloat(p.size)),
        entryPrice: parseFloat(p.avgPrice),
        markPrice: parseFloat(p.markPrice),
        unRealizedProfit: parseFloat(p.unrealisedPnl),
        leverage: parseInt(p.leverage),
        notional: Math.abs(parseFloat(p.positionValue)),
        exchange: 'bybit',
      }));
  }
}

// ── Get open orders ───────────────────────────────────────────────────────────
async function getOpenOrders(symbol, creds) {
  if (creds.exchange === 'binance') {
    const data = await binanceSigned('GET', '/fapi/v1/openOrders', { symbol }, creds);
    return (Array.isArray(data) ? data : []).map(o => ({
      orderId: o.orderId, symbol: o.symbol, side: o.side,
      type: o.type, qty: parseFloat(o.origQty),
      price: parseFloat(o.price), stopPrice: parseFloat(o.stopPrice),
      status: o.status, ts: o.time, exchange: 'binance',
    }));
  } else {
    const data = await bybitSigned('GET', '/v5/order/realtime', { category: 'linear', symbol }, creds);
    return (data?.list || []).map(o => ({
      orderId: o.orderId, symbol: o.symbol,
      side: o.side === 'Buy' ? 'BUY' : 'SELL',
      type: o.orderType.toUpperCase(), qty: parseFloat(o.qty),
      price: parseFloat(o.price), stopPrice: parseFloat(o.triggerPrice || '0'),
      status: o.orderStatus, ts: parseInt(o.createdTime), exchange: 'bybit',
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

const _tsConfigs = {};  // symbol → TrailingStopConfig
let   _tsCreds   = null;

function tsLoad() {
  try {
    const saved = JSON.parse(localStorage.getItem('cryptoTool_trailingStops') || '{}');
    Object.assign(_tsConfigs, saved);
  } catch {}
}
function tsSave() {
  try { localStorage.setItem('cryptoTool_trailingStops', JSON.stringify(_tsConfigs)); } catch {}
}

function tsEnable(position, riskAmount) {
  const { symbol, side, positionAmt: size, entryPrice } = position;
  const R = riskAmount;
  // Build level tables (price values)
  const sign  = side === 'LONG' ? 1 : -1;
  const levels = TS_LEVELS.map(l => ({
    targetPrice: entryPrice + sign * (R * l.targetR) / size,
    stopPrice:   entryPrice + sign * (R * l.stopR)   / size,
    targetR: l.targetR, stopR: l.stopR, reached: false,
  }));
  _tsConfigs[symbol] = {
    symbol, side, size, entryPrice, R,
    currentLevel: 0,  // 0 = no level reached yet
    currentStop:  levels[0].stopPrice - sign * (R * TS_LEVELS[0].stopR) / size, // initial stop
    highestPrice: entryPrice, lowestPrice: entryPrice,
    levels, activeStopOrderId: null, ts: Date.now(),
  };
  tsSave();
  window.trading?.onLevelAdvance?.(symbol, 0, levels[0].stopPrice);
}

function tsDisable(symbol) {
  delete _tsConfigs[symbol];
  tsSave();
}

async function tsOnPriceUpdate(symbol, price, creds) {
  const cfg = _tsConfigs[symbol];
  if (!cfg) return;

  // Track extremes
  if (cfg.side === 'LONG' && price > cfg.highestPrice) cfg.highestPrice = price;
  if (cfg.side === 'SHORT' && price < cfg.lowestPrice)  cfg.lowestPrice  = price;

  const extreme    = cfg.side === 'LONG' ? cfg.highestPrice : cfg.lowestPrice;
  const sign       = cfg.side === 'LONG' ? 1 : -1;

  // Find highest level whose target is met
  let newLevel = cfg.currentLevel;
  for (let i = cfg.levels.length - 1; i >= 0; i--) {
    const l = cfg.levels[i];
    const met = cfg.side === 'LONG' ? price >= l.targetPrice : price <= l.targetPrice;
    if (met) { newLevel = i + 1; break; }
  }

  if (newLevel > cfg.currentLevel) {
    cfg.currentLevel = newLevel;
    const l = cfg.levels[newLevel - 1];
    cfg.currentStop = l.stopPrice;
    // Notify UI
    const pct = (TS_LEVELS[newLevel - 1].targetR * 100).toFixed(0);
    window.showToast?.(`🎯 Trailing stop: Level ${newLevel} reached (+${pct}R). Stop locked at +${(TS_LEVELS[newLevel-1].stopR * 100).toFixed(0)}R`, 'success');
    window.trading?.onLevelAdvance?.(symbol, newLevel, cfg.currentStop);
  }

  // Additional trailing component (level ≥ 2): trail at 0.10R from extreme
  if (cfg.currentLevel >= 2 && creds) {
    const trailStop = extreme - sign * (0.10 * cfg.R) / cfg.size;
    if (cfg.side === 'LONG'  && trailStop > cfg.currentStop) cfg.currentStop = trailStop;
    if (cfg.side === 'SHORT' && trailStop < cfg.currentStop) cfg.currentStop = trailStop;
  }

  // Place updated stop order if moved > 0.1% of entry
  if (creds && cfg._lastPlacedStop !== undefined) {
    const moved = Math.abs(cfg.currentStop - cfg._lastPlacedStop) / cfg.entryPrice;
    if (moved > 0.001) {
      try {
        if (cfg.activeStopOrderId) await cancelOrder(symbol, cfg.activeStopOrderId, creds).catch(() => {});
        const info   = await getSymbolInfo(symbol, creds);
        const stopSide = cfg.side === 'LONG' ? 'SELL' : 'BUY';
        if (creds.exchange === 'binance') {
          const res = await binanceSigned('POST', '/fapi/v1/order', {
            symbol, side: stopSide, type: 'STOP_MARKET',
            stopPrice: cfg.currentStop.toFixed(info.pricePrecision),
            quantity:  cfg.size.toFixed(info.quantityPrecision),
            workingType: 'MARK_PRICE', priceProtect: 'TRUE', reduceOnly: 'true',
          }, creds);
          cfg.activeStopOrderId = res.orderId;
        } else {
          const res = await bybitSigned('POST', '/v5/order/create', {
            category: 'linear', symbol, side: stopSide,
            orderType: 'Market', qty: cfg.size.toFixed(info.quantityPrecision),
            triggerPrice: cfg.currentStop.toFixed(info.pricePrecision),
            triggerDirection: cfg.side === 'LONG' ? 2 : 1,
            triggerBy: 'MarkPrice', reduceOnly: true,
          }, creds);
          cfg.activeStopOrderId = res?.orderId;
        }
        cfg._lastPlacedStop = cfg.currentStop;
        window.trading?.onStopUpdate?.(symbol, cfg.currentStop);
      } catch (e) {
        console.warn('[TrailingStop] Failed to update stop order:', e.message);
      }
    }
  } else {
    cfg._lastPlacedStop = cfg.currentStop;
  }

  tsSave();
}

// ── Init ──────────────────────────────────────────────────────────────────────
tsLoad();

window.trading = {
  placeOrder,
  cancelOrder: (s, id) => cancelOrder(s, id, _tsCreds),
  closePosition: (s, side, qty) => closePosition(s, side, qty, _tsCreds),
  setLeverage: (s, lev) => setLeverage(s, lev, _tsCreds),
  getPositions: () => getPositions(_tsCreds),
  getOpenOrders: (s) => getOpenOrders(s, _tsCreds),
  setCreds: (creds) => { _tsCreds = creds; },
  calculateQty,
  getSymbolInfo: (s) => getSymbolInfo(s, _tsCreds),
  trailingStop: {
    enable:        (pos, R)   => tsEnable(pos, R),
    disable:       (sym)      => tsDisable(sym),
    onPriceUpdate: (sym, p)   => tsOnPriceUpdate(sym, p, _tsCreds),
    getAll:        ()         => Object.values(_tsConfigs),
    get:           (sym)      => _tsConfigs[sym],
  },
  // Event hooks — app.js overrides these
  onLevelAdvance: null,
  onStopUpdate:   null,
};
