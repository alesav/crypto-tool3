/**
 * risk-calculator.ts
 * Risk-based position sizing. Per CLONE_SPECIFICATION §12.3
 */

export interface SymbolInfo {
  pricePrecision: number;
  quantityPrecision: number;
  minNotional: number;
  minQty: number;
  stepSize: number;
  tickSize: number;
  maxLeverage: number;
}

export interface OrderCalc {
  quantity: number;
  positionValue: number;
  marginRequired: number;
  actualRisk: number;
  riskPercentage: number;
  priceMove: number;
  priceMovePct: number;
  quantityFormatted: string;
  entryFormatted: string;
  stopFormatted: string;
  valid: boolean;
  error?: string;
}

const DEFAULT_INFO: SymbolInfo = {
  pricePrecision: 2, quantityPrecision: 3,
  minNotional: 5, minQty: 0.001,
  stepSize: 0.001, tickSize: 0.01, maxLeverage: 100,
};

function roundDown(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function formatQty(qty: number, info: SymbolInfo): string {
  return qty.toFixed(info.quantityPrecision);
}

export function calculateOrder(
  entryPrice: number,
  stopLossPrice: number,
  maxLossAmount: number,
  leverage: number,
  side: 'BUY' | 'SELL',
  info: SymbolInfo = DEFAULT_INFO
): OrderCalc {
  const fail = (error: string): OrderCalc => ({
    quantity: 0, positionValue: 0, marginRequired: 0,
    actualRisk: 0, riskPercentage: 0, priceMove: 0, priceMovePct: 0,
    quantityFormatted: '0', entryFormatted: '0', stopFormatted: '0',
    valid: false, error,
  });

  if (entryPrice <= 0) return fail('Entry price must be > 0');
  if (maxLossAmount <= 0) return fail('Max loss must be > 0');
  if (leverage < 1 || leverage > 100) return fail('Leverage must be 1-100');

  if (side === 'BUY'  && stopLossPrice >= entryPrice) return fail('Stop must be below entry for BUY');
  if (side === 'SELL' && stopLossPrice <= entryPrice) return fail('Stop must be above entry for SELL');

  const priceDiff = Math.abs(entryPrice - stopLossPrice);
  if (priceDiff / entryPrice < 0.0001) return fail('Stop distance too small (< 0.01%)');

  const rawQty = maxLossAmount / priceDiff;
  const qty = Math.max(info.minQty, roundDown(rawQty, info.stepSize));
  const positionValue = qty * entryPrice;
  const marginRequired = positionValue / leverage;
  const actualRisk = qty * priceDiff;

  if (positionValue < info.minNotional) return fail(`Position value below minimum (${info.minNotional} USDT)`);

  return {
    quantity: qty,
    positionValue,
    marginRequired,
    actualRisk,
    riskPercentage: (actualRisk / maxLossAmount) * 100,
    priceMove: priceDiff,
    priceMovePct: (priceDiff / entryPrice) * 100,
    quantityFormatted: formatQty(qty, info),
    entryFormatted: entryPrice.toFixed(info.pricePrecision),
    stopFormatted: stopLossPrice.toFixed(info.pricePrecision),
    valid: true,
  };
}

export function suggestStopLoss(entry: number, side: 'BUY' | 'SELL', riskPct = 0.02): number {
  return side === 'BUY'
    ? entry * (1 - riskPct)
    : entry * (1 + riskPct);
}

export function calculateLiquidationPrice(
  entry: number, leverage: number, side: 'BUY' | 'SELL', maintenanceMargin = 0.004
): number {
  if (side === 'BUY') return entry * (1 - (1 / leverage) + maintenanceMargin);
  return entry * (1 + (1 / leverage) - maintenanceMargin);
}

// ── HMAC-SHA256 signing (WebCrypto) ──────────────────────
export async function hmacSHA256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Binance signed request ────────────────────────────────
export async function binanceSignedRequest(
  method: string, endpoint: string,
  params: Record<string, string | number>,
  apiKey: string, apiSecret: string
): Promise<any> {
  const ts = Date.now();
  const qsBase = Object.entries({ ...params, timestamp: ts, recvWindow: 5000 })
    .map(([k, v]) => `${k}=${v}`).join('&');
  const sig = await hmacSHA256(apiSecret, qsBase);
  const qs = `${qsBase}&signature=${sig}`;
  const url = `https://fapi.binance.com${endpoint}?${qs}`;
  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': apiKey },
    ...(method !== 'GET' ? { body: qs } : {}),
  });
  return res.json();
}

// ── Bybit signed request ──────────────────────────────────
export async function bybitSignedRequest(
  method: string, endpoint: string,
  params: Record<string, string | number>,
  apiKey: string, apiSecret: string
): Promise<any> {
  const ts = Date.now().toString();
  const recvWindow = '5000';
  const payload = method === 'GET'
    ? Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&')
    : JSON.stringify(params);
  const msg = `${ts}${apiKey}${recvWindow}${payload}`;
  const sig = await hmacSHA256(apiSecret, msg);
  const url = `https://api.bybit.com${endpoint}${method === 'GET' ? '?' + payload : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'X-BAPI-SIGN': sig,
      'Content-Type': 'application/json',
    },
    ...(method !== 'GET' ? { body: JSON.stringify(params) } : {}),
  });
  return res.json();
}
