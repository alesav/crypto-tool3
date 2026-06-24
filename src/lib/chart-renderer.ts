/**
 * chart-renderer.ts
 * Full chart rendering pipeline: candles, grid, indicators, manual lines, volume.
 */

import {
  type Candle, type Scale,
  computeScale, priceToY, yToPrice, indexToX, timestampToX, xToTimestamp,
  priceGridLines, formatPrice, formatVolume, clearCanvas, setupCanvas,
  MARGINS, DEFAULT_VISIBLE_CANDLES, MIN_VISIBLE, MAX_VISIBLE, ZOOM_STEP, EXTRA_BARS,
  crossingPrice,
} from './chart-math';
import type { ManualLine } from './store';

// ── Colors ────────────────────────────────────────────────
const C = {
  bull:       '#0ecb81',
  bear:       '#f6465d',
  grid:       'rgba(255,255,255,0.04)',
  gridLabel:  '#4a5568',
  crosshair:  'rgba(255,255,255,0.25)',
  priceLine:  '#f0b90b',
  alertLine:  '#3b82f6',
  alertTriggered: 'rgba(59,130,246,0.4)',
  manualLine: '#94a3b8',
  manualSel:  '#f0b90b',
  diag:       { support: '#10b981', resistance: '#f87171' },
  volBull:    'rgba(14,203,129,0.55)',
  volBear:    'rgba(246,70,93,0.55)',
};

export interface DrawState {
  mode: 'none' | 'drawing' | 'stop-loss';
  tempLine: { price1: number; ts1: number; price2?: number; ts2?: number } | null;
  selectedLineId: string | null;
  crosshairX: number;
  crosshairY: number;
  showCrosshair: boolean;
}

export class ChartRenderer {
  private priceCanvas: HTMLCanvasElement;
  private volumeCanvas: HTMLCanvasElement;
  private pCtx!: CanvasRenderingContext2D;
  private vCtx!: CanvasRenderingContext2D;

  data: Candle[] = [];
  visibleCount: number = DEFAULT_VISIBLE_CANDLES;
  scrollOffset: number = 0;
  drawState: DrawState = {
    mode: 'none', tempLine: null, selectedLineId: null,
    crosshairX: 0, crosshairY: 0, showCrosshair: false,
  };

  manualLines: ManualLine[] = [];
  diagLines: DiagLine[] = [];
  alerts: AlertLine[] = [];
  stopLossPrice: number | null = null;
  currentSymbol = '';

  private _rafId = 0;
  private _isDirty = true;

  constructor(priceCanvas: HTMLCanvasElement, volumeCanvas: HTMLCanvasElement) {
    this.priceCanvas = priceCanvas;
    this.volumeCanvas = volumeCanvas;
    this._resize();
  }

  _resize() {
    const pw = this.priceCanvas.parentElement?.clientWidth || 600;
    const ph = this.priceCanvas.parentElement?.clientHeight || 400;
    const vw = this.volumeCanvas.parentElement?.clientWidth || 600;
    const vh = this.volumeCanvas.parentElement?.clientHeight || 80;
    this.pCtx = setupCanvas(this.priceCanvas, pw, ph);
    this.vCtx = setupCanvas(this.volumeCanvas, vw, vh);
    this.markDirty();
  }

  markDirty() {
    this._isDirty = true;
    if (!this._rafId) this._rafId = requestAnimationFrame(() => {
      this._rafId = 0;
      if (this._isDirty) { this._isDirty = false; this._render(); }
    });
  }

  destroy() { cancelAnimationFrame(this._rafId); }

  // ── Public interaction ────────────────────────────────
  getScaleNow(): Scale | null {
    if (!this.data.length) return null;
    const pw = this.priceCanvas.clientWidth;
    const ph = this.priceCanvas.clientHeight;
    return computeScale(this.data, this.visibleCount, this.scrollOffset, pw, ph);
  }

  zoom(delta: number) {
    this.visibleCount = Math.max(MIN_VISIBLE, Math.min(MAX_VISIBLE, this.visibleCount + delta));
    this.markDirty();
  }

  pan(deltaCandles: number) {
    const max = Math.max(0, this.data.length - this.visibleCount);
    this.scrollOffset = Math.max(0, Math.min(max, this.scrollOffset + deltaCandles));
    this.markDirty();
  }

  snapToLatest() { this.scrollOffset = 0; this.markDirty(); }

  isScrolledAway(): boolean { return this.scrollOffset > 10; }

  // ── Main render ───────────────────────────────────────
  private _render() {
    const pw = this.priceCanvas.clientWidth;
    const ph = this.priceCanvas.clientHeight;
    const vw = this.volumeCanvas.clientWidth;
    const vh = this.volumeCanvas.clientHeight;

    clearCanvas(this.pCtx, pw, ph);
    clearCanvas(this.vCtx, vw, vh);

    if (!this.data.length) return;

    const s = computeScale(this.data, this.visibleCount, this.scrollOffset, pw, ph);

    this._drawGrid(s, pw, ph);
    this._drawCandles(s);
    this._drawCurrentPriceLine(s, pw);
    this._drawDiagLines(s, pw);
    this._drawManualLines(s, pw);
    this._drawAlertLines(s, pw);
    if (this.drawState.mode === 'stop-loss' && this.stopLossPrice !== null) {
      this._drawStopLossLine(s, pw);
    }
    if (this.drawState.tempLine) this._drawTempLine(s, pw);
    if (this.drawState.showCrosshair) this._drawCrosshair(s, pw, ph);
    this._drawVolume(s, vw, vh);
  }

  // ── Grid + labels ─────────────────────────────────────
  private _drawGrid(s: Scale, w: number, h: number) {
    const ctx = this.pCtx;
    const ca = s.chartArea;

    // Price grid lines
    const lines = priceGridLines(s);
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (const p of lines) {
      const y = Math.round(priceToY(p, s)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(ca.x, y);
      ctx.lineTo(ca.x + ca.width, y);
      ctx.stroke();
      // Label in right margin
      ctx.fillStyle = C.gridLabel;
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(formatPrice(p), ca.x + ca.width + 4, y + 4);
    }

    // Time labels
    const targetTimeSteps = Math.max(2, Math.floor(ca.width / 100));
    const stride = Math.max(1, Math.round(s.candlesToShow / targetTimeSteps));
    ctx.fillStyle = C.gridLabel;
    ctx.textAlign = 'center';
    ctx.font = '10px JetBrains Mono, monospace';
    for (let vi = 0; vi < s.candlesToShow; vi += stride) {
      const di = s.startIndex + vi;
      if (di >= this.data.length) break;
      const x = Math.round(indexToX(vi, s));
      const d = new Date(this.data[di].openTime);
      const label = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      ctx.fillText(label, x, h - MARGINS.bottom + 14);
    }
  }

  // ── Candles ───────────────────────────────────────────
  private _drawCandles(s: Scale) {
    const ctx = this.pCtx;
    const ca = s.chartArea;
    const candleW = Math.max(1, s.xScale * 0.75);

    ctx.save();
    ctx.beginPath();
    ctx.rect(ca.x, ca.y, ca.width, ca.height);
    ctx.clip();

    for (let vi = 0; vi < s.candlesToShow; vi++) {
      const di = s.startIndex + vi;
      if (di >= this.data.length) break;
      const c = this.data[di];
      const x = indexToX(vi, s);
      const bull = c.close >= c.open;
      const color = bull ? C.bull : C.bear;

      // Wick
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, priceToY(c.high, s));
      ctx.lineTo(x, priceToY(c.low, s));
      ctx.stroke();

      // Body
      const bodyTop = Math.min(priceToY(c.open, s), priceToY(c.close, s));
      const bodyH = Math.max(1, Math.abs(priceToY(c.open, s) - priceToY(c.close, s)));
      ctx.fillStyle = color;
      ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
    }
    ctx.restore();
  }

  // ── Current price dotted line ─────────────────────────
  private _drawCurrentPriceLine(s: Scale, w: number) {
    if (!this.data.length) return;
    const last = this.data[this.data.length - 1].close;
    const y = priceToY(last, s);
    if (y < s.chartArea.y || y > s.chartArea.y + s.chartArea.height) return;

    const ctx = this.pCtx;
    ctx.save();
    ctx.strokeStyle = C.priceLine;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(s.chartArea.x, y);
    ctx.lineTo(s.chartArea.x + s.chartArea.width, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Tag
    const label = formatPrice(last);
    const tagW = label.length * 7 + 8;
    ctx.fillStyle = C.priceLine;
    ctx.fillRect(s.chartArea.x + s.chartArea.width + 2, y - 9, tagW, 18);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 10px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(label, s.chartArea.x + s.chartArea.width + 5, y + 4);
    ctx.restore();
  }

  // ── Diagonal indicator lines ──────────────────────────
  private _drawDiagLines(s: Scale, w: number) {
    for (const line of this.diagLines) {
      this._drawExtendedLine(
        line.ts1, line.price1, line.ts2, line.price2,
        s, w,
        line.type === 'support' ? C.diag.support : C.diag.resistance,
        1.5, false
      );
    }
  }

  // ── Manual lines ──────────────────────────────────────
  private _drawManualLines(s: Scale, w: number) {
    for (const line of this.manualLines) {
      const isSel = line.id === this.drawState.selectedLineId;
      const color = isSel ? C.manualSel : C.manualLine;
      const width = isSel ? 2 : 1.5;
      this._drawExtendedLine(line.ts1, line.price1, line.ts2, line.price2, s, w, color, width, line.isHorizontal);
      if (isSel) {
        this._drawControlPoints(line, s);
      }
    }
  }

  private _drawControlPoints(line: ManualLine, s: Scale) {
    const ctx = this.pCtx;
    const x1 = timestampToX(line.ts1, this.data, s);
    const y1 = priceToY(line.price1, s);
    const x2 = timestampToX(line.ts2, this.data, s);
    const y2 = priceToY(line.price2, s);
    ctx.fillStyle = C.manualSel;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // ── Alert lines ───────────────────────────────────────
  private _drawAlertLines(s: Scale, w: number) {
    for (const al of this.alerts) {
      const color = al.triggered ? C.alertTriggered : C.alertLine;
      if (al.line) {
        this._drawExtendedLine(al.line.ts1, al.line.price1, al.line.ts2, al.line.price2, s, w, color, 1, false, al.triggered);
      } else {
        // Horizontal at targetPrice
        const y = priceToY(al.targetPrice, s);
        const ctx = this.pCtx;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        if (al.triggered) ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(s.chartArea.x, y);
        ctx.lineTo(s.chartArea.x + s.chartArea.width, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // ── Stop loss line ────────────────────────────────────
  private _drawStopLossLine(s: Scale, w: number) {
    if (this.stopLossPrice === null) return;
    const y = priceToY(this.stopLossPrice, s);
    const ctx = this.pCtx;
    ctx.save();
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 4]);
    ctx.beginPath();
    ctx.moveTo(s.chartArea.x, y);
    ctx.lineTo(s.chartArea.x + s.chartArea.width, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#f97316';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('SL: ' + formatPrice(this.stopLossPrice), s.chartArea.x + 8, y - 4);
    ctx.restore();
  }

  // ── Temp drawing line ─────────────────────────────────
  private _drawTempLine(s: Scale, w: number) {
    const tl = this.drawState.tempLine!;
    if (!tl.ts2) return;
    this._drawExtendedLine(tl.ts1, tl.price1, tl.ts2!, tl.price2!, s, w, C.manualSel, 1.5, false);
  }

  // ── Crosshair ─────────────────────────────────────────
  private _drawCrosshair(s: Scale, w: number, h: number) {
    const ctx = this.pCtx;
    const { crosshairX: x, crosshairY: y } = this.drawState;
    ctx.save();
    ctx.strokeStyle = C.crosshair;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(s.chartArea.x, y);
    ctx.lineTo(s.chartArea.x + s.chartArea.width, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const price = yToPrice(y, s);
    const label = formatPrice(price);
    const tagW = label.length * 7 + 8;
    ctx.fillStyle = '#2a3340';
    ctx.fillRect(s.chartArea.x + s.chartArea.width + 2, y - 9, tagW, 18);
    ctx.fillStyle = '#e8ecf0';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(label, s.chartArea.x + s.chartArea.width + 5, y + 4);
    ctx.restore();
  }

  // ── Volume chart ──────────────────────────────────────
  private _drawVolume(s: Scale, w: number, h: number) {
    const ctx = this.vCtx;
    const slice = this.data.slice(s.startIndex, s.startIndex + s.candlesToShow);
    if (!slice.length) return;
    const maxVol = Math.max(...slice.map(c => c.volume));
    if (maxVol === 0) return;

    const barW = Math.max(1, s.xScale * 0.75);
    const padding = 4;

    for (let vi = 0; vi < slice.length; vi++) {
      const c = slice[vi];
      const x = s.chartArea.x + vi * s.xScale + (s.xScale - barW) / 2;
      const bh = Math.max(1, (c.volume / maxVol) * (h - padding));
      const y = h - bh - padding;
      ctx.fillStyle = c.close >= c.open ? C.volBull : C.volBear;
      ctx.fillRect(x, y, barW, bh);
    }

    // Volume labels
    ctx.fillStyle = '#4a5568';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(formatVolume(maxVol), s.chartArea.x + s.chartArea.width + 4, 12);
    ctx.fillText(formatVolume(maxVol / 2), s.chartArea.x + s.chartArea.width + 4, h / 2);
    ctx.fillText('0', s.chartArea.x + s.chartArea.width + 4, h - 2);
  }

  // ── Helper: extended ray ──────────────────────────────
  private _drawExtendedLine(
    ts1: number, price1: number, ts2: number, price2: number,
    s: Scale, w: number,
    color: string, lineWidth: number,
    horizontal: boolean,
    dashed = false
  ) {
    const ctx = this.pCtx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (dashed) ctx.setLineDash([6, 4]);

    const x1 = timestampToX(ts1, this.data, s);
    const y1 = priceToY(price1, s);
    if (horizontal) {
      ctx.beginPath();
      ctx.moveTo(s.chartArea.x, y1);
      ctx.lineTo(s.chartArea.x + s.chartArea.width, y1);
    } else {
      const x2 = timestampToX(ts2, this.data, s);
      const y2 = priceToY(price2, s);
      const endX = s.chartArea.x + s.chartArea.width;
      const slope = x2 !== x1 ? (y2 - y1) / (x2 - x1) : 0;
      const endY = y1 + (endX - x1) * slope;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(endX, endY);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

// ── Types for indicator lines ─────────────────────────────
export interface DiagLine {
  ts1: number; price1: number;
  ts2: number; price2: number;
  type: 'support' | 'resistance';
  currentPrice: number;
  quality?: number;
}

export interface AlertLine {
  id: string;
  targetPrice: number;
  triggered: boolean;
  line?: { ts1: number; price1: number; ts2: number; price2: number; };
}
