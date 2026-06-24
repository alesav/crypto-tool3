/**
 * chart-math.ts
 * Core coordinate system for the crypto chart.
 * All drawing operations derive from these transforms.
 */

export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isKlineClosed?: boolean;
}

export interface ChartMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ChartArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Scale {
  minPrice: number;
  maxPrice: number;
  xScale: number;
  yScale: number;
  startIndex: number;
  candlesToShow: number;
  chartArea: ChartArea;
}

export const MARGINS: ChartMargins = { top: 20, right: 80, bottom: 40, left: 10 };
export const DEFAULT_VISIBLE_CANDLES = 120;
export const MIN_VISIBLE = 20;
export const MAX_VISIBLE = 800;
export const ZOOM_STEP = 30;
export const EXTRA_BARS = 5; // right-edge breathing room

/** Setup HiDPI canvas */
export function setupCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  return ctx;
}

export function clearCanvas(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

/** Compute the scale for the current visible window */
export function computeScale(
  data: Candle[],
  visibleCount: number,
  scrollOffset: number,
  cssW: number,
  cssH: number
): Scale {
  const { top, right, bottom, left } = MARGINS;
  const ca: ChartArea = {
    x: left,
    y: top,
    width: cssW - left - right,
    height: cssH - top - bottom,
  };

  const candlesToShow = Math.min(data.length, visibleCount);
  const startIndex = Math.max(0, data.length - candlesToShow - scrollOffset);
  const endIndex = Math.min(data.length, startIndex + candlesToShow);

  let minPrice = Infinity;
  let maxPrice = -Infinity;
  for (let i = startIndex; i < endIndex; i++) {
    if (data[i].low  < minPrice) minPrice = data[i].low;
    if (data[i].high > maxPrice) maxPrice = data[i].high;
  }
  if (!isFinite(minPrice)) { minPrice = 0; maxPrice = 1; }

  const pad = (maxPrice - minPrice) * 0.10;
  minPrice -= pad;
  maxPrice += pad;

  const effectiveLen = candlesToShow + EXTRA_BARS;
  const xScale = ca.width / effectiveLen;
  const yScale = ca.height / (maxPrice - minPrice);

  return { minPrice, maxPrice, xScale, yScale, startIndex, candlesToShow, chartArea: ca };
}

/** Convert price → canvas Y coordinate */
export function priceToY(price: number, s: Scale): number {
  return s.chartArea.y + (s.maxPrice - price) * s.yScale;
}

/** Convert canvas Y → price */
export function yToPrice(y: number, s: Scale): number {
  return s.maxPrice - (y - s.chartArea.y) / s.yScale;
}

/** Convert visible-slice index → canvas X (center of slot) */
export function indexToX(i: number, s: Scale): number {
  return s.chartArea.x + i * s.xScale + s.xScale * 0.5;
}

/** Convert canvas X → fractional visible index */
export function xToIndex(x: number, s: Scale): number {
  return (x - s.chartArea.x) / s.xScale;
}

/** Convert timestamp → canvas X using closest candle */
export function timestampToX(ts: number, data: Candle[], s: Scale): number {
  let closest = s.startIndex;
  let bestDiff = Infinity;
  for (let i = s.startIndex; i < s.startIndex + s.candlesToShow && i < data.length; i++) {
    const diff = Math.abs(data[i].openTime - ts);
    if (diff < bestDiff) { bestDiff = diff; closest = i; }
  }
  return indexToX(closest - s.startIndex, s);
}

/** Convert canvas X → timestamp using candle at that slot */
export function xToTimestamp(x: number, data: Candle[], s: Scale): number {
  const i = Math.round(xToIndex(x, s)) + s.startIndex;
  const clamped = Math.max(0, Math.min(data.length - 1, i));
  return data[clamped].openTime;
}

/** "Nice numbers" price grid */
export function priceGridLines(s: Scale): number[] {
  const targetSteps = Math.max(2, Math.floor(s.chartArea.height / 50));
  const range = s.maxPrice - s.minPrice;
  const rawStep = range / targetSteps;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const n = rawStep / mag;
  const step = (n <= 1.5 ? 1 : n <= 3 ? 2 : n <= 7 ? 5 : 10) * mag;
  const first = Math.ceil(s.minPrice / step) * step;
  const lines: number[] = [];
  for (let p = first; p <= s.maxPrice; p += step) lines.push(p);
  return lines;
}

/** Dynamic price formatting */
export function formatPrice(p: number): string {
  if (p === undefined || isNaN(p)) return '—';
  if (p < 0.01)  return p.toFixed(8);
  if (p < 1)     return p.toFixed(4);
  if (p < 100)   return p.toFixed(3);
  if (p < 1000)  return p.toFixed(2);
  return p.toLocaleString('en', { maximumFractionDigits: 0 });
}

/** Format volume with K/M/B */
export function formatVolume(v: number): string {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

/** Compute the crossing price of a diagonal line at a given timestamp */
export function crossingPrice(
  price1: number, ts1: number,
  price2: number, ts2: number,
  atTs: number
): number {
  if (ts2 === ts1) return price1;
  const slope = (price2 - price1) / (ts2 - ts1);
  return price1 + slope * (atTs - ts1);
}
