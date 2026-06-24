/**
 * exchange.ts
 * Exchange API adapters for Binance Futures and Bybit Linear.
 * All fetch calls go through the rate limiter.
 */

export type ExchangeId = 'binance' | 'bybit';

export interface Coin {
  symbol: string;        // display, e.g. "BTC"
  fullSymbol: string;    // e.g. "BTCUSDT"
  lastPrice: number;
  priceChange: number;
  priceChangePercent: number;
  volume: number;
  quoteVolume: number;
  highPrice: number;
  lowPrice: number;
  volumeChange: number;  // 12h vol change %
  exchange: ExchangeId;
  lastUpdateTime: number;
}

// ── Rate limiter (token bucket, ~50 req/min) ──────────────
const RATE_WINDOW = 60_000;
const MAX_REQUESTS = 50;
const MIN_SPACING = 200;

let requestTimestamps: number[] = [];
let lastRequestTime = 0;

async function throttledFetch(url: string, init?: RequestInit): Promise<Response> {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(t => now - t < RATE_WINDOW);
  if (requestTimestamps.length >= MAX_REQUESTS) {
    const oldest = requestTimestamps[0];
    await sleep(RATE_WINDOW - (now - oldest) + 100);
  }
  const sinceLastReq = Date.now() - lastRequestTime;
  if (sinceLastReq < MIN_SPACING) await sleep(MIN_SPACING - sinceLastReq);
  lastRequestTime = Date.now();
  requestTimestamps.push(lastRequestTime);
  return fetch(url, init);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Binance ───────────────────────────────────────────────
const BNAPI = 'https://fapi.binance.com';

export async function binanceTickers(): Promise<Coin[]> {
  const [infoRes, tickersRes] = await Promise.all([
    throttledFetch(`${BNAPI}/fapi/v1/exchangeInfo`),
    throttledFetch(`${BNAPI}/fapi/v1/ticker/24hr`),
  ]);
  const info = await infoRes.json();
  const tickers = await tickersRes.json();

  const tradeable = new Set<string>(
    (info.symbols || [])
      .filter((s: any) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT'))
      .map((s: any) => s.symbol)
  );

  return (tickers as any[])
    .filter((t: any) => tradeable.has(t.symbol))
    .map((t: any) => ({
      symbol: t.symbol.replace('USDT', ''),
      fullSymbol: t.symbol,
      lastPrice: parseFloat(t.lastPrice),
      priceChange: parseFloat(t.priceChange),
      priceChangePercent: parseFloat(t.priceChangePercent),
      volume: parseFloat(t.volume),
      quoteVolume: parseFloat(t.quoteVolume),
      highPrice: parseFloat(t.highPrice),
      lowPrice: parseFloat(t.lowPrice),
      volumeChange: 0,
      exchange: 'binance' as ExchangeId,
      lastUpdateTime: Date.now(),
    }));
}

export async function bybitTickers(): Promise<Coin[]> {
  const [infoRes, tickersRes] = await Promise.all([
    throttledFetch(`https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000`),
    throttledFetch(`https://api.bybit.com/v5/market/tickers?category=linear`),
  ]);
  const info = await infoRes.json();
  const data = await tickersRes.json();

  const tradeable = new Set<string>(
    (info.result?.list || [])
      .filter((s: any) => s.status === 'Trading' && s.symbol.endsWith('USDT'))
      .map((s: any) => s.symbol)
  );

  return (data.result?.list || [])
    .filter((t: any) => tradeable.has(t.symbol))
    .map((t: any) => ({
      symbol: t.symbol.replace('USDT', ''),
      fullSymbol: t.symbol,
      lastPrice: parseFloat(t.lastPrice),
      priceChange: parseFloat(t.price24hPcnt) * parseFloat(t.lastPrice),
      priceChangePercent: parseFloat(t.price24hPcnt) * 100,
      volume: parseFloat(t.volume24h),
      quoteVolume: parseFloat(t.turnover24h),
      highPrice: parseFloat(t.highPrice24h),
      lowPrice: parseFloat(t.lowPrice24h),
      volumeChange: 0,
      exchange: 'bybit' as ExchangeId,
      lastUpdateTime: Date.now(),
    }));
}

// ── Klines ────────────────────────────────────────────────
import type { Candle } from './chart-math';

export async function fetchKlines(
  exchange: ExchangeId,
  symbol: string,
  interval: string,
  limit = 500
): Promise<Candle[]> {
  if (exchange === 'binance') {
    const res = await throttledFetch(
      `${BNAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    );
    const data: any[][] = await res.json();
    return data.slice(0, -1).map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
      isKlineClosed: true,
    }));
  } else {
    const res = await throttledFetch(
      `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitInterval(interval)}&limit=${limit}`
    );
    const data = await res.json();
    const list: any[][] = (data.result?.list || []).reverse();
    return list.slice(0, -1).map(k => ({
      openTime: parseInt(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: parseInt(k[0]) + intervalMs(interval) - 1,
      isKlineClosed: true,
    }));
  }
}

function bybitInterval(interval: string): string {
  const map: Record<string, string> = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
  return map[interval] || '15';
}

function intervalMs(interval: string): number {
  const map: Record<string, number> = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
  return map[interval] || 900e3;
}

// ── WebSocket kline stream ────────────────────────────────
export function createKlineStream(
  exchange: ExchangeId,
  symbol: string,
  interval: string,
  onCandle: (c: Candle) => void
): () => void {
  let ws: WebSocket;
  let reconnectTimer: ReturnType<typeof setTimeout>;
  let attempts = 0;

  function connect() {
    if (exchange === 'binance') {
      ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@kline_${interval}`);
      ws.onmessage = (ev) => {
        const d = JSON.parse(ev.data);
        const k = d.k;
        onCandle({
          openTime: k.t, closeTime: k.T,
          open: parseFloat(k.o), high: parseFloat(k.h),
          low: parseFloat(k.l), close: parseFloat(k.c),
          volume: parseFloat(k.v), isKlineClosed: k.x,
        });
      };
    } else {
      ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
      ws.onopen = () => {
        ws.send(JSON.stringify({ op: 'subscribe', args: [`kline.${bybitInterval(interval)}.${symbol}`] }));
      };
      ws.onmessage = (ev) => {
        const d = JSON.parse(ev.data);
        if (d.topic?.startsWith('kline') && d.data?.[0]) {
          const k = d.data[0];
          onCandle({
            openTime: k.start, closeTime: k.end,
            open: parseFloat(k.open), high: parseFloat(k.high),
            low: parseFloat(k.low), close: parseFloat(k.close),
            volume: parseFloat(k.volume),
            isKlineClosed: k.confirm,
          });
        }
      };
    }

    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (attempts < 5) {
        const delay = Math.min(5000 * Math.pow(1.5, attempts), 30000);
        reconnectTimer = setTimeout(() => { attempts++; connect(); }, delay);
      }
    };
    ws.onopen = (ws.onopen) || (() => { attempts = 0; });
  }

  connect();
  return () => { clearTimeout(reconnectTimer); ws?.close(); };
}

// ── Mini-ticker stream (all symbols, for alerts) ──────────
export function createMiniTickerStream(
  onPrices: (prices: Map<string, number>) => void
): () => void {
  let ws: WebSocket;
  let reconnectTimer: ReturnType<typeof setTimeout>;
  let attempts = 0;

  function connect() {
    ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.onmessage = (ev) => {
      const data: any[] = JSON.parse(ev.data);
      const map = new Map<string, number>();
      for (const t of data) map.set(t.s, parseFloat(t.c));
      onPrices(map);
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (attempts < 10) {
        const delay = Math.min(5000 * Math.pow(1.5, attempts), 30000);
        reconnectTimer = setTimeout(() => { attempts++; connect(); }, delay);
      }
    };
    ws.onopen = () => { attempts = 0; };
  }

  connect();
  return () => { clearTimeout(reconnectTimer); ws?.close(); };
}
