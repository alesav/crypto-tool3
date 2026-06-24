/**
 * app.js — Main application bootstrap (v2, bugs fixed)
 *
 * Fixes applied:
 * 1. Binance WS frozen  — proper canvas clear using raw pixel coords;
 *    single ws.onopen per exchange branch; resizeCanvas resets transform.
 * 2. Chart blinking     — loadToken: each loadChart() increments a counter;
 *    updateCandle() discards messages from superseded streams.
 * 3. Mobile swipe       — touch-action:none set on canvas wrapper via JS.
 * 4. Lines on scroll    — ts2xFull() computes unclamped x from timestamp,
 *    drawRay() clips to chart area and extrapolates slope correctly.
 */

// ── Toast ─────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const c = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Tab switching ─────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${tab}`)?.classList.add('active');
  });
});

// ── Timeframe ─────────────────────────────────────────────
let currentInterval = '15m';
document.querySelectorAll('.tf-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentInterval = btn.dataset.tf;
    if (currentSymbol) loadChart(currentSymbol, currentExchange);
  });
});

// ── Global state ──────────────────────────────────────────
let currentSymbol   = '';
let currentExchange = 'binance';
let allCoins        = [];
let sortCol         = 'priceChangePercent';
let sortDir         = 'desc';
let wsCleanup       = null;
let scannerTimer    = null;
let scannerIndex    = 0;
let scannerCoins    = [];
let isAuthenticated = false;
let tradeSide       = 'BUY';
let tradeMode       = 'market';

// Chart state
let chartData       = [];
let visibleCount    = 120;
let scrollOffset    = 0;
let rafId           = 0;
let chartDirty      = false;
let manualLines     = [];
let drawMode        = false;
let tempLine        = null;
let selectedLineId  = null;
let isDragging      = false;
let pointerStart    = null;
let pointerStartOffset = 0;
let showCrosshair   = false;
let crosshairX      = 0;
let crosshairY      = 0;
let diagLines       = [];
let activeIndicator = 'diagonal';
let stopLossMode    = false;

// FIX #2: load token — each loadChart() gets a unique ID.
// WS callbacks capture their token and ignore updates if token changed.
let loadToken = 0;

const MARGINS   = { top: 20, right: 80, bottom: 40, left: 10 };
const EXTRA_BARS = 5;

// Restore saved symbol
try {
  const last = JSON.parse(localStorage.getItem('cryptoTool_lastSymbol') || '{}');
  if (last.symbol) { currentSymbol = last.symbol; currentExchange = last.exchange || 'binance'; }
} catch {}

// ── FIX #3: prevent browser swipe-scroll from hijacking canvas touch ──
const priceCanvas  = document.getElementById('price-canvas');
const volumeCanvas = document.getElementById('volume-canvas');
if (priceCanvas.parentElement)  priceCanvas.parentElement.style.touchAction  = 'none';
if (volumeCanvas.parentElement) volumeCanvas.parentElement.style.touchAction = 'none';

// ── Canvas helpers ────────────────────────────────────────
// Resize backing store if needed, then unconditionally re-apply the DPR
// transform so every frame starts from a clean, known state.
// Returns the DPR so callers don't need to recompute it.
function prepareCanvas(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const w   = Math.round(canvas.clientWidth  * dpr);
  const h   = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = w;
    canvas.height = h;
  }
  // Always reset to identity first, then apply DPR scale.
  // This guarantees the transform is correct regardless of what
  // previous save/restore pairs left behind.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Clear using CSS-pixel dimensions (correct after the scale above).
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  return dpr;
}

// Legacy aliases kept for callers that use clearCanvas/resizeCanvas separately
// (none in this file after the refactor, but kept for safety).
function clearCanvas(ctx, canvas) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function resizeCanvas(canvas, ctx) {
  prepareCanvas(canvas, ctx);
}

// ── Scale / coordinate system ─────────────────────────────
function computeScale(w, h) {
  const ca = {
    x: MARGINS.left, y: MARGINS.top,
    width:  w - MARGINS.left - MARGINS.right,
    height: h - MARGINS.top  - MARGINS.bottom,
  };
  const candlesToShow = Math.min(chartData.length, visibleCount);
  const startIndex    = Math.max(0, chartData.length - candlesToShow - scrollOffset);
  let minP = Infinity, maxP = -Infinity;
  for (let i = startIndex; i < startIndex + candlesToShow && i < chartData.length; i++) {
    if (chartData[i].low  < minP) minP = chartData[i].low;
    if (chartData[i].high > maxP) maxP = chartData[i].high;
  }
  if (!isFinite(minP)) { minP = 0; maxP = 1; }
  const pad    = (maxP - minP) * 0.10;
  minP -= pad; maxP += pad;
  const xScale = ca.width  / (candlesToShow + EXTRA_BARS);
  const yScale = ca.height / (maxP - minP);
  return { minP, maxP, xScale, yScale, startIndex, candlesToShow, ca };
}

function p2y(price, s) { return s.ca.y + (s.maxP - price) * s.yScale; }
function y2p(y, s)     { return s.maxP - (y - s.ca.y) / s.yScale; }
function i2x(i, s)     { return s.ca.x + i * s.xScale + s.xScale * 0.5; }

// FIX #4: return the true canvas-x for a timestamp, even when off-screen left.
// We do NOT clamp — negative values are fine; drawRay clips to chart area.
function ts2xFull(ts, s) {
  const ivMs = chartData.length >= 2
    ? (chartData[1].openTime - chartData[0].openTime)
    : 900_000; // 15m fallback
  const dataIdx = (ts - chartData[0].openTime) / ivMs; // fractional data index
  const visIdx  = dataIdx - s.startIndex;               // can be < 0 if off-screen
  return s.ca.x + visIdx * s.xScale + s.xScale * 0.5;
}

// x → nearest candle timestamp (clamped, used only for drawing cursor / click)
function x2ts(x, s) {
  const i = Math.round((x - s.ca.x) / s.xScale) + s.startIndex;
  return chartData[Math.max(0, Math.min(chartData.length - 1, i))].openTime;
}

function fmtPrice(p) {
  if (p == null || isNaN(p)) return '—';
  if (p < 0.01)  return p.toFixed(8);
  if (p < 1)     return p.toFixed(4);
  if (p < 100)   return p.toFixed(3);
  if (p < 1000)  return p.toFixed(2);
  return p.toLocaleString('en', { maximumFractionDigits: 0 });
}

// ── Render pipeline ───────────────────────────────────────
function markDirty() {
  chartDirty = true;
  if (!rafId) rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (chartDirty) { chartDirty = false; renderChart(); }
  });
}

function renderChart() {
  const pw = priceCanvas.clientWidth;
  const ph = priceCanvas.clientHeight;
  const vw = volumeCanvas.clientWidth;
  const vh = volumeCanvas.clientHeight;
  if (!pw || !ph) return;

  const ctx  = priceCanvas.getContext('2d');
  const vctx = volumeCanvas.getContext('2d');

  // prepareCanvas: resize if needed, reset DPR transform, clear — all in one call.
  // This guarantees the transform is always correct before any drawing.
  prepareCanvas(priceCanvas,  ctx);
  prepareCanvas(volumeCanvas, vctx);

  if (!chartData.length) return;
  const s = computeScale(pw, ph);

  drawGrid(ctx, s, pw, ph);
  drawCandles(ctx, s);
  drawCurrentPrice(ctx, s);
  if (activeIndicator === 'diagonal') drawDiagLines(ctx, s);
  drawManualLines(ctx, s);
  drawAlertLines(ctx, s);
  if (stopLossMode) drawStopLossPreview(ctx, s);
  if (tempLine && tempLine.ts2) drawTempLine(ctx, s);
  if (showCrosshair && !drawMode && !stopLossMode) drawCrosshair(ctx, s, pw, ph);
  drawVolume(vctx, s, vw, vh);

  document.getElementById('btn-latest').classList.toggle('visible', scrollOffset > 10);
}

// ── Grid ──────────────────────────────────────────────────
function drawGrid(ctx, s, w, h) {
  const range = s.maxP - s.minP;
  const tgt   = Math.max(2, Math.floor(s.ca.height / 50));
  const raw   = range / tgt;
  const mag   = Math.pow(10, Math.floor(Math.log10(raw)));
  const n     = raw / mag;
  const step  = (n <= 1.5 ? 1 : n <= 3 ? 2 : n <= 7 ? 5 : 10) * mag;
  const first = Math.ceil(s.minP / step) * step;

  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth   = 1;
  ctx.font        = '10px JetBrains Mono, monospace';
  ctx.fillStyle   = '#4a5568';
  ctx.textAlign   = 'left';

  for (let p = first; p <= s.maxP; p += step) {
    const y = Math.round(p2y(p, s)) + 0.5;
    ctx.beginPath(); ctx.moveTo(s.ca.x, y); ctx.lineTo(s.ca.x + s.ca.width, y); ctx.stroke();
    ctx.fillText(fmtPrice(p), s.ca.x + s.ca.width + 4, y + 4);
  }

  const stride = Math.max(1, Math.round(s.candlesToShow / Math.max(2, Math.floor(s.ca.width / 100))));
  ctx.textAlign = 'center';
  for (let vi = 0; vi < s.candlesToShow; vi += stride) {
    const di = s.startIndex + vi;
    if (di >= chartData.length) break;
    const x   = Math.round(i2x(vi, s));
    const d   = new Date(chartData[di].openTime);
    const lbl = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    ctx.fillText(lbl, x, h - MARGINS.bottom + 14);
  }
}

// ── Candles ───────────────────────────────────────────────
function drawCandles(ctx, s) {
  const cw = Math.max(1, s.xScale * 0.75);
  ctx.save();
  ctx.beginPath(); ctx.rect(s.ca.x, s.ca.y, s.ca.width, s.ca.height); ctx.clip();
  for (let vi = 0; vi < s.candlesToShow; vi++) {
    const di  = s.startIndex + vi;
    if (di >= chartData.length) break;
    const c   = chartData[di];
    const x   = i2x(vi, s);
    const col = c.close >= c.open ? '#0ecb81' : '#f6465d';
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, p2y(c.high, s)); ctx.lineTo(x, p2y(c.low, s)); ctx.stroke();
    const bt = Math.min(p2y(c.open, s), p2y(c.close, s));
    const bh = Math.max(1, Math.abs(p2y(c.open, s) - p2y(c.close, s)));
    ctx.fillStyle = col;
    ctx.fillRect(x - cw / 2, bt, cw, bh);
  }
  ctx.restore();
}

// ── Current-price line ────────────────────────────────────
function drawCurrentPrice(ctx, s) {
  if (!chartData.length) return;
  const price = chartData[chartData.length - 1].close;
  const y     = p2y(price, s);
  if (y < s.ca.y || y > s.ca.y + s.ca.height) return;
  ctx.save();
  ctx.strokeStyle = '#f0b90b'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(s.ca.x, y); ctx.lineTo(s.ca.x + s.ca.width, y); ctx.stroke();
  ctx.setLineDash([]);
  const lbl  = fmtPrice(price);
  const tagW = lbl.length * 7 + 10;
  ctx.fillStyle = '#f0b90b';
  ctx.fillRect(s.ca.x + s.ca.width + 2, y - 9, tagW, 18);
  ctx.fillStyle = '#000'; ctx.font = 'bold 10px JetBrains Mono, monospace'; ctx.textAlign = 'left';
  ctx.fillText(lbl, s.ca.x + s.ca.width + 5, y + 4);
  ctx.restore();
}

// ── Indicator lines ───────────────────────────────────────
function drawDiagLines(ctx, s) {
  for (const l of diagLines)
    drawRay(ctx, s, l.ts1, l.price1, l.ts2, l.price2,
      l.type === 'support' ? '#10b981' : '#f87171', 1.5);
}

// ── Manual lines ──────────────────────────────────────────
function drawManualLines(ctx, s) {
  for (const line of manualLines) {
    const sel = line.id === selectedLineId;
    drawRay(ctx, s, line.ts1, line.price1, line.ts2, line.price2,
      sel ? '#f0b90b' : '#94a3b8', sel ? 2 : 1.5, line.isHorizontal);
    if (sel) {
      for (const [ts, pr] of [[line.ts1, line.price1], [line.ts2, line.price2]]) {
        const x = ts2xFull(ts, s), y = p2y(pr, s);
        // Only draw dot if within chart area
        if (x >= s.ca.x && x <= s.ca.x + s.ca.width) {
          ctx.fillStyle = '#f0b90b'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
    }
  }
}

// ── Alert lines ───────────────────────────────────────────
function drawAlertLines(ctx, s) {
  for (const al of loadAlertsLocal().filter(a => a.symbol === currentSymbol)) {
    const col = al.isTriggered ? 'rgba(59,130,246,0.4)' : '#3b82f6';
    if (al.line) {
      drawRay(ctx, s, al.line.ts1, al.line.price1, al.line.ts2, al.line.price2,
        col, 1, false, al.isTriggered);
    } else {
      const y = p2y(al.targetPrice, s);
      ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1;
      if (al.isTriggered) ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(s.ca.x, y); ctx.lineTo(s.ca.x + s.ca.width, y); ctx.stroke();
      ctx.setLineDash([]); ctx.restore();
    }
  }
}

// ── Stop-loss preview ─────────────────────────────────────
function drawStopLossPreview(ctx, s) {
  const y     = crosshairY;
  const price = y2p(y, s);
  ctx.save();
  ctx.strokeStyle = '#f97316'; ctx.lineWidth = 1.5; ctx.setLineDash([8, 4]);
  ctx.beginPath(); ctx.moveTo(s.ca.x, y); ctx.lineTo(s.ca.x + s.ca.width, y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#f97316'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('SL: ' + fmtPrice(price), s.ca.x + 8, y - 4);
  ctx.restore();
}

function drawTempLine(ctx, s) {
  drawRay(ctx, s, tempLine.ts1, tempLine.price1, tempLine.ts2, tempLine.price2, '#f0b90b', 1.5);
}

// ── Crosshair ─────────────────────────────────────────────
function drawCrosshair(ctx, s, w, h) {
  const y    = crosshairY;
  const lbl  = fmtPrice(y2p(y, s));
  const tagW = lbl.length * 7 + 8;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.setLineDash([5, 5]);
  ctx.beginPath(); ctx.moveTo(s.ca.x, y); ctx.lineTo(s.ca.x + s.ca.width, y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#2a3340';
  ctx.fillRect(s.ca.x + s.ca.width + 2, y - 9, tagW, 18);
  ctx.fillStyle = '#e8ecf0'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'left';
  ctx.fillText(lbl, s.ca.x + s.ca.width + 5, y + 4);
  ctx.restore();
}

// ── Volume chart ──────────────────────────────────────────
function drawVolume(ctx, s, w, h) {
  const slice = chartData.slice(s.startIndex, s.startIndex + s.candlesToShow);
  if (!slice.length) return;
  const maxV = Math.max(...slice.map(c => c.volume));
  if (!maxV) return;
  const bw = Math.max(1, s.xScale * 0.75), pad = 4;
  for (let vi = 0; vi < slice.length; vi++) {
    const c  = slice[vi];
    const x  = s.ca.x + vi * s.xScale + (s.xScale - bw) / 2;
    const bh = Math.max(1, (c.volume / maxV) * (h - pad));
    ctx.fillStyle = c.close >= c.open ? 'rgba(14,203,129,0.55)' : 'rgba(246,70,93,0.55)';
    ctx.fillRect(x, h - bh - pad, bw, bh);
  }
}

// ── FIX #4: drawRay with unclamped timestamp extrapolation ──
// ts2xFull() can return x < ca.x (anchor off-screen left).
// We clip the canvas ctx to chartArea so nothing bleeds into the axes,
// then draw from left edge to right edge along the computed slope.
function drawRay(ctx, s, ts1, p1, ts2, p2, color, lw = 1.5, horizontal = false, dashed = false) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  if (dashed) ctx.setLineDash([6, 4]);

  // Clip drawing to the chart area (prevents bleeding into label margins)
  ctx.beginPath();
  ctx.rect(s.ca.x, s.ca.y, s.ca.width, s.ca.height);
  ctx.clip();

  if (horizontal) {
    const y = p2y(p1, s);
    ctx.beginPath(); ctx.moveTo(s.ca.x, y); ctx.lineTo(s.ca.x + s.ca.width, y);
  } else {
    // Unclamped pixel positions — slope is now always correct
    const x1 = ts2xFull(ts1, s), y1 = p2y(p1, s);
    const x2 = ts2xFull(ts2, s), y2 = p2y(p2, s);
    const dx = x2 - x1;

    if (Math.abs(dx) < 0.001) {
      // Degenerate: same timestamp both anchors — draw flat
      ctx.beginPath(); ctx.moveTo(s.ca.x, y1); ctx.lineTo(s.ca.x + s.ca.width, y1);
    } else {
      const slope  = (y2 - y1) / dx;
      const startX = s.ca.x;                  // left clip boundary
      const endX   = s.ca.x + s.ca.width;     // right clip boundary
      const startY = y1 + (startX - x1) * slope;
      const endY   = y1 + (endX   - x1) * slope;
      ctx.beginPath(); ctx.moveTo(startX, startY); ctx.lineTo(endX, endY);
    }
  }

  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// ── Load chart data ───────────────────────────────────────
async function loadChart(symbol, exchange) {
  // FIX #2: bump token — old WS callbacks will see token mismatch and bail
  const myToken = ++loadToken;

  document.getElementById('overlay-placeholder').classList.add('hidden');
  document.getElementById('overlay-loading').classList.remove('hidden');
  document.getElementById('overlay-error').classList.add('hidden');
  document.getElementById('chart-title').textContent =
    symbol.replace('USDT', '/USDT') + ' · ' + currentInterval;

  // Close old stream before fetch so no stale writes arrive
  if (wsCleanup) { wsCleanup(); wsCleanup = null; }

  try {
    const url = exchange === 'binance'
      ? `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${currentInterval}&limit=500`
      : `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${toBybitInterval(currentInterval)}&limit=500`;

    const res = await fetch(url);
    const raw = await res.json();

    // Bail if another loadChart() started while we awaited the fetch
    if (myToken !== loadToken) return;

    if (exchange === 'binance') {
      chartData = (Array.isArray(raw) ? raw.slice(0, -1) : []).map(k => ({
        openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], closeTime: k[6],
      }));
    } else {
      const list = (raw.result?.list || []).reverse();
      chartData = list.slice(0, -1).map(k => ({
        openTime: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
        closeTime: +k[0] + intervalMs(currentInterval) - 1,
      }));
    }

    try { manualLines = JSON.parse(localStorage.getItem(`cryptoTool_lines_${symbol}`) || '[]'); } catch { manualLines = []; }
    if (activeIndicator === 'diagonal') diagLines = calcDiagSR(chartData);

    document.getElementById('overlay-loading').classList.add('hidden');
    scrollOffset = 0;
    markDirty();

    wsCleanup = subscribeKline(symbol, exchange, myToken);

  } catch (e) {
    if (myToken !== loadToken) return;
    const errEl = document.getElementById('overlay-error');
    errEl.textContent = 'Error loading chart: ' + e.message;
    errEl.classList.remove('hidden');
    document.getElementById('overlay-loading').classList.add('hidden');
  }
}

function toBybitInterval(iv) {
  return { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' }[iv] || '15';
}
function intervalMs(iv) {
  return { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 }[iv] || 900e3;
}

// FIX #1 + #2: one ws.onopen per branch; updateCandle checks token.
function subscribeKline(symbol, exchange, token) {
  let ws, reconnTimer, attempts = 0;

  function connect() {
    if (exchange === 'binance') {
      ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@kline_${currentInterval}`);
      ws.onopen    = () => { attempts = 0; };
      ws.onmessage = ev => {
        const d = JSON.parse(ev.data), k = d.k;
        updateCandleWithHeartbeat({ openTime: k.t, closeTime: k.T, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v }, token);
      };
    } else {
      ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
      ws.onopen = () => {
        attempts = 0;
        ws.send(JSON.stringify({ op: 'subscribe', args: [`kline.${toBybitInterval(currentInterval)}.${symbol}`] }));
      };
      ws.onmessage = ev => {
        const d = JSON.parse(ev.data);
        if (d.topic?.startsWith('kline') && d.data?.[0]) {
          const k = d.data[0];
          updateCandleWithHeartbeat({ openTime: k.start, closeTime: k.end, open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: +k.volume }, token);
        }
      };
    }
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (attempts < 5) {
        reconnTimer = setTimeout(() => { attempts++; connect(); }, Math.min(5000 * Math.pow(1.5, attempts), 30000));
      }
    };
  }

  connect();
  return () => { clearTimeout(reconnTimer); try { ws?.close(); } catch {} };
}

// FIX #2: discard updates from a superseded stream
function updateCandle(candle, token) {
  if (token !== loadToken) return;
  if (!chartData.length)   return;
  const last = chartData[chartData.length - 1];
  if (candle.openTime === last.openTime) {
    chartData[chartData.length - 1] = { ...last, ...candle };
  } else if (candle.openTime > last.openTime) {
    chartData.push(candle);
    if (chartData.length > 1000) chartData.shift();
    if (scrollOffset <= 10) scrollOffset = 0;
    if (activeIndicator === 'diagonal') diagLines = calcDiagSR(chartData);
  }
  markDirty();
}

// ── REST price polling (Binance fallback) ─────────────────
// Polls /ticker/price every 2s to keep the last candle's close updated.
// This works regardless of WS delivery — acts as a guaranteed heartbeat.
let _lastPollTime = 0;
let _pollFailures = 0;

async function pollCurrentPrice() {
  if (!currentSymbol || currentExchange !== 'binance') return;
  if (!chartData.length) return;
  // Throttle: don't poll if a WS message updated within last 3s
  if (Date.now() - _lastPollTime < 1800) return;

  try {
    const res  = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${currentSymbol}`);
    const data = await res.json();
    const price = parseFloat(data.price);
    if (!price || isNaN(price)) return;
    _pollFailures = 0;

    const last = chartData[chartData.length - 1];
    if (!last) return;

    // Update the live candle's close/high/low
    const updated = { ...last, close: price };
    if (price > last.high) updated.high = price;
    if (price < last.low)  updated.low  = price;
    chartData[chartData.length - 1] = updated;
    markDirty();
  } catch {
    _pollFailures++;
  }
}

// Mark last WS message time so polling backs off when WS is healthy
function updateCandleWithHeartbeat(candle, token) {
  _lastPollTime = Date.now();
  updateCandle(candle, token);
}

setInterval(pollCurrentPrice, 2000);

// ── Diagonal S/R indicator ────────────────────────────────
function calcDiagSR(data) {
  if (data.length < 20) return [];
  const hr = 4, lows = [], highs = [];
  const start = Math.max(hr, data.length - 150);

  for (let i = start; i < data.length - hr; i++) {
    let isL = true, isH = true;
    for (let j = i - hr; j <= i + hr; j++) {
      if (j === i || j < 0 || j >= data.length) continue;
      if (data[j].low  <= data[i].low)  isL = false;
      if (data[j].high >= data[i].high) isH = false;
    }
    if (isL) lows.push({ index: i, price: data[i].low });
    if (isH) highs.push({ index: i, price: data[i].high });
  }

  lows.sort((a, b) => b.index - a.index);
  highs.sort((a, b) => b.index - a.index);
  const cur = data.length - 1;

  function priceAt(b1, p1, b2, p2, t) {
    return b2 === b1 ? p1 : p1 + (p2 - p1) * (t - b1) / (b2 - b1);
  }
  function intersects(b1, p1, b2, p2, type) {
    for (let i = b1 + 1; i < b2; i++) {
      const lp = priceAt(b1, p1, b2, p2, i);
      if (type === 'support'    && Math.min(data[i].open, data[i].close) < lp) return true;
      if (type === 'resistance' && Math.max(data[i].open, data[i].close) > lp) return true;
    }
    return false;
  }

  const lines = [];
  let sc = 0, rc = 0;

  for (let i = 0; i < Math.min(lows.length, 30) && sc < 5; i++) {
    const p1 = lows[i];
    for (let j = i + 1; j < Math.min(lows.length, i + 30) && sc < 5; j++) {
      const p2 = lows[j];
      if (p1.index - p2.index < 20) continue;
      if (intersects(p2.index, p2.price, p1.index, p1.price, 'support')) continue;
      const cl = priceAt(p2.index, p2.price, p1.index, p1.price, cur);
      if (cl >= data[cur].high) continue;
      lines.push({ ts1: data[p2.index].openTime, price1: p2.price, ts2: data[p1.index].openTime, price2: p1.price, type: 'support', currentPrice: cl });
      sc++; break;
    }
  }
  for (let i = 0; i < Math.min(highs.length, 30) && rc < 5; i++) {
    const p1 = highs[i];
    for (let j = i + 1; j < Math.min(highs.length, i + 30) && rc < 5; j++) {
      const p2 = highs[j];
      if (p1.index - p2.index < 20) continue;
      if (intersects(p2.index, p2.price, p1.index, p1.price, 'resistance')) continue;
      const cl = priceAt(p2.index, p2.price, p1.index, p1.price, cur);
      if (cl <= data[cur].low) continue;
      lines.push({ ts1: data[p2.index].openTime, price1: p2.price, ts2: data[p1.index].openTime, price2: p1.price, type: 'resistance', currentPrice: cl });
      rc++; break;
    }
  }
  return lines;
}

// ── Pointer events ────────────────────────────────────────
priceCanvas.addEventListener('pointermove', e => {
  const rect = priceCanvas.getBoundingClientRect();
  crosshairX = e.clientX - rect.left;
  crosshairY = e.clientY - rect.top;
  showCrosshair = true;

  if (drawMode && tempLine && chartData.length) {
    const s    = computeScale(priceCanvas.clientWidth, priceCanvas.clientHeight);
    tempLine.ts2    = x2ts(crosshairX, s);
    tempLine.price2 = y2p(crosshairY, s);
  }

  if (pointerStart && !drawMode) {
    const dx = e.clientX - pointerStart.x;
    if (Math.abs(dx) > 5) {
      isDragging = true;
      const s   = computeScale(priceCanvas.clientWidth, priceCanvas.clientHeight);
      const max = Math.max(0, chartData.length - visibleCount);
      // Natural chart drag: drag RIGHT → pull chart right → older candles scroll in from left
      // → scrollOffset INCREASES. drag LEFT → newer candles → scrollOffset DECREASES.
      // So: offset = start + dx/xScale  (positive dx → more offset → older candles)
      scrollOffset = Math.max(0, Math.min(max, pointerStartOffset + Math.round(dx / s.xScale)));
    }
  }
  markDirty();
});

priceCanvas.addEventListener('pointerdown', e => {
  priceCanvas.setPointerCapture(e.pointerId);
  pointerStart       = { x: e.clientX, y: e.clientY };
  pointerStartOffset = scrollOffset;
  isDragging         = false;
});

priceCanvas.addEventListener('pointerup', e => {
  priceCanvas.releasePointerCapture(e.pointerId);
  if (!isDragging) handleChartClick(e);
  pointerStart = null;
  isDragging   = false;
});

priceCanvas.addEventListener('pointercancel', () => { pointerStart = null; isDragging = false; });
priceCanvas.addEventListener('pointerleave',  () => { showCrosshair = false; markDirty(); });

priceCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  const max    = Math.max(0, chartData.length - visibleCount);
  const delta  = e.deltaY > 0 ? 15 : -15;
  scrollOffset = Math.max(0, Math.min(max, scrollOffset + delta));
  markDirty();
}, { passive: false });

priceCanvas.addEventListener('dblclick', () => { scrollOffset = 0; markDirty(); });

// ── Click / tap handling ──────────────────────────────────
function handleChartClick(e) {
  const rect = priceCanvas.getBoundingClientRect();
  const x    = e.clientX - rect.left;
  const y    = e.clientY - rect.top;
  if (!chartData.length) return;
  const s = computeScale(priceCanvas.clientWidth, priceCanvas.clientHeight);

  if (stopLossMode) {
    const price = y2p(y, s);
    document.getElementById('stop-loss').value = price.toFixed(6);
    stopLossMode = false;
    priceCanvas.style.cursor = 'default';
    showToast('Stop loss set: ' + fmtPrice(price));
    computeOrderPreview();
    markDirty();
    return;
  }

  if (drawMode) {
    if (!tempLine) {
      tempLine = { ts1: x2ts(x, s), price1: y2p(y, s), ts2: x2ts(x, s), price2: y2p(y, s) };
    } else {
      const ts2 = x2ts(x, s), pr2 = y2p(y, s);
      const isH = Math.abs(pr2 - tempLine.price1) / tempLine.price1 < 0.001;
      manualLines.push({
        id: Date.now().toString(),
        ts1: tempLine.ts1, price1: tempLine.price1,
        ts2, price2: isH ? tempLine.price1 : pr2,
        isHorizontal: isH,
      });
      selectedLineId = manualLines[manualLines.length - 1].id;
      saveLinesLocal();
      tempLine = null; drawMode = false;
      document.getElementById('btn-draw').classList.remove('active');
      priceCanvas.style.cursor = 'default';
      markDirty();
    }
    return;
  }

  // Hit-test manual lines using unclamped coordinates
  for (let i = manualLines.length - 1; i >= 0; i--) {
    const line = manualLines[i];
    const x1   = ts2xFull(line.ts1, s), y1 = p2y(line.price1, s);
    const x2   = ts2xFull(line.ts2, s), y2 = p2y(line.price2, s);
    let dist;
    if (line.isHorizontal) {
      dist = Math.abs(y - y1);
    } else {
      const dx = x2 - x1, dy = y2 - y1;
      const t  = (dx || 1) === 0 ? 0 : ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
      const nx = x1 + t * dx, ny = y1 + t * dy;
      dist = Math.hypot(x - nx, y - ny);
    }
    if (dist < 8) {
      selectedLineId = line.id;
      showLineStatus(line);
      markDirty();
      return;
    }
  }

  selectedLineId = null;
  document.getElementById('line-status').classList.remove('visible');
  markDirty();
}

function showLineStatus(line) {
  const popup = document.getElementById('line-status');
  const price = line.isHorizontal ? fmtPrice(line.price1) : fmtPrice(line.price2);
  popup.innerHTML = `
    <div style="font-family:var(--font-mono);font-size:12px;color:var(--text-hi);margin-bottom:8px">
      ${line.isHorizontal ? 'Horizontal' : 'Diagonal'} line · ${price}
    </div>
    <div style="display:flex;gap:6px">
      <button class="alert-btn" onclick="createAlertFromLine('${line.id}')">🔔 Alert</button>
      <button class="alert-btn danger" onclick="deleteLine('${line.id}')">Delete</button>
    </div>`;
  popup.classList.add('visible');
}

window.deleteLine = id => {
  manualLines = manualLines.filter(l => l.id !== id);
  selectedLineId = null;
  document.getElementById('line-status').classList.remove('visible');
  saveLinesLocal(); markDirty();
};

window.createAlertFromLine = id => {
  const line = manualLines.find(l => l.id === id);
  if (!line || !currentSymbol) return;
  const price = line.isHorizontal ? line.price1 : line.price2;
  const alert = {
    id: Date.now().toString(), symbol: currentSymbol, type: 'cross-any',
    targetPrice: price,
    line: line.isHorizontal ? null : { ts1: line.ts1, price1: line.price1, ts2: line.ts2, price2: line.price2 },
    isActive: true, isTriggered: false, frequency: 'once', createdAt: Date.now(),
  };
  const alerts = loadAlertsLocal();
  alerts.push(alert);
  saveAlertsLocal(alerts);
  renderAlerts(); updateAlertBadge();
  showToast('Alert created at ' + fmtPrice(price));
  document.getElementById('line-status').classList.remove('visible');
};

function saveLinesLocal() {
  try { localStorage.setItem(`cryptoTool_lines_${currentSymbol}`, JSON.stringify(manualLines)); } catch {}
}

// ── Chart button controls ─────────────────────────────────
document.getElementById('btn-draw').addEventListener('click', () => {
  drawMode = !drawMode; tempLine = null;
  document.getElementById('btn-draw').classList.toggle('active', drawMode);
  priceCanvas.style.cursor = drawMode ? 'crosshair' : 'default';
  markDirty();
});
document.getElementById('btn-clear').addEventListener('click', () => {
  if (!currentSymbol) return;
  if (confirm('Clear all lines for ' + currentSymbol + '?')) {
    manualLines = []; selectedLineId = null;
    saveLinesLocal();
    document.getElementById('line-status').classList.remove('visible');
    markDirty();
  }
});
document.getElementById('btn-zoom-in').addEventListener('click',  () => { visibleCount = Math.max(20,  visibleCount - 30); markDirty(); });
document.getElementById('btn-zoom-out').addEventListener('click', () => { visibleCount = Math.min(800, visibleCount + 30); markDirty(); });
document.getElementById('btn-latest').addEventListener('click',   () => { scrollOffset = 0; markDirty(); });
document.getElementById('btn-fullscreen').addEventListener('click', () => {
  const el = document.querySelector('.chart-panel');
  document.fullscreenElement ? document.exitFullscreen?.() : el.requestFullscreen?.();
});
document.getElementById('select-indicator').addEventListener('change', e => {
  activeIndicator = e.target.value;
  diagLines = activeIndicator === 'diagonal' ? calcDiagSR(chartData) : [];
  markDirty();
});

// ── Keyboard shortcuts ────────────────────────────────────
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  switch (e.key) {
    case 'Escape':
      drawMode = false; tempLine = null; stopLossMode = false; selectedLineId = null;
      document.getElementById('btn-draw').classList.remove('active');
      priceCanvas.style.cursor = 'default';
      document.getElementById('line-status').classList.remove('visible');
      markDirty(); break;
    case 'Delete': case 'Backspace':
      if (selectedLineId) window.deleteLine(selectedLineId); break;
    case '+': case '=': visibleCount = Math.max(20,  visibleCount - 30); markDirty(); break;
    case '-':            visibleCount = Math.min(800, visibleCount + 30); markDirty(); break;
    case 'ArrowLeft':
      scrollOffset = Math.min(Math.max(0, chartData.length - visibleCount), scrollOffset + 5);
      markDirty(); break;
    case 'ArrowRight':
      scrollOffset = Math.max(0, scrollOffset - 5); markDirty(); break;
    case 'End': scrollOffset = 0; markDirty(); break;
    case 'd': case 'D': document.getElementById('btn-draw').click(); break;
  }
});

window.addEventListener('resize', () => markDirty());

// ── Coins list ────────────────────────────────────────────
async function loadCoins(exchange) {
  const btn = document.getElementById('btn-refresh');
  btn.classList.add('spinning');
  try {
    const url = exchange === 'binance'
      ? 'https://fapi.binance.com/fapi/v1/ticker/24hr'
      : 'https://api.bybit.com/v5/market/tickers?category=linear';
    const res  = await fetch(url);
    const data = await res.json();
    const minVol = parseFloat(document.getElementById('vol-filter').value || '20') * 1e6;
    if (exchange === 'binance') {
      allCoins = (Array.isArray(data) ? data : [])
        .filter(t => t.symbol.endsWith('USDT'))
        .map(t => ({ symbol: t.symbol.replace('USDT',''), fullSymbol: t.symbol, lastPrice: +t.lastPrice, priceChangePercent: +t.priceChangePercent, quoteVolume: +t.quoteVolume, volumeChange: 0, exchange: 'binance' }))
        .filter(c => c.quoteVolume >= minVol);
    } else {
      allCoins = (data.result?.list || [])
        .filter(t => t.symbol.endsWith('USDT'))
        .map(t => ({ symbol: t.symbol.replace('USDT',''), fullSymbol: t.symbol, lastPrice: +t.lastPrice, priceChangePercent: +t.price24hPcnt * 100, quoteVolume: +t.turnover24h, volumeChange: 0, exchange: 'bybit' }))
        .filter(c => c.quoteVolume >= minVol);
    }
    renderCoinsTable();
    renderScannerTable();
    // Do NOT reload the chart here — loadChart is called separately on symbol select.
    // Calling it here bumps loadToken and orphans the WS that was created first,
    // causing all subsequent Binance WS messages to be silently discarded.
  } catch (e) {
    showToast('Failed to load coins: ' + e.message, 'error');
  } finally {
    btn.classList.remove('spinning');
  }
}

function fmtPct(v) {
  const n = parseFloat(v);
  return isNaN(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}
function fmtVol(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return v.toFixed(0);
}

function getFilteredSorted() {
  const f = document.getElementById('sym-filter').value.toUpperCase();
  let coins = allCoins.filter(c => !f || c.symbol.includes(f));
  coins.sort((a, b) => {
    let va = a[sortCol], vb = b[sortCol];
    if (sortCol === 'priceChangePercent') { va = Math.abs(va); vb = Math.abs(vb); }
    if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return sortDir === 'asc' ? va - vb : vb - va;
  });
  return coins;
}

function renderCoinsTable() {
  const coins = getFilteredSorted();
  document.getElementById('coins-tbody').innerHTML = coins.map(c => {
    const cc  = c.priceChangePercent > 0 ? 'bull' : c.priceChangePercent < 0 ? 'bear' : 'neu';
    const vc  = c.volumeChange > 0 ? 'bull' : c.volumeChange < 0 ? 'bear' : 'neu';
    const sel = c.fullSymbol === currentSymbol ? 'selected' : '';
    return `<tr class="coin-row ${sel}" data-symbol="${c.fullSymbol}" data-exchange="${c.exchange}">
      <td><span class="sym">${c.symbol}</span></td>
      <td>${fmtPrice(c.lastPrice)}</td>
      <td class="${cc}">${fmtPct(c.priceChangePercent)}</td>
      <td class="${vc}">${c.volumeChange !== 0 ? fmtPct(c.volumeChange) : '—'}</td>
      <td>${fmtVol(c.quoteVolume)}</td>
    </tr>`;
  }).join('');
  document.querySelectorAll('.coin-row').forEach(r => {
    r.addEventListener('click', () => selectCoin(r.dataset.symbol, r.dataset.exchange));
  });
}

function selectCoin(symbol, exchange) {
  currentSymbol   = symbol;
  currentExchange = exchange;
  try { localStorage.setItem('cryptoTool_lastSymbol', JSON.stringify({ symbol, exchange })); } catch {}
  renderCoinsTable();
  loadChart(symbol, exchange);
  const trSym = document.getElementById('trade-symbol');
  if (trSym) trSym.textContent = symbol.replace('USDT', '/USDT');
  computeOrderPreview();
}

document.querySelectorAll('#coins-table th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    sortDir = sortCol === col ? (sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
    sortCol = col;
    document.querySelectorAll('#coins-table th').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
    th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    renderCoinsTable();
  });
});

document.getElementById('exch-select').addEventListener('change', e => {
  currentExchange = e.target.value;
  loadCoins(currentExchange).then(() => {
    // After coin list refreshes for new exchange, reload the chart if a symbol is selected
    if (currentSymbol) loadChart(currentSymbol, currentExchange);
  });
});
document.getElementById('sym-filter').addEventListener('input', renderCoinsTable);
document.getElementById('sym-clear').addEventListener('click', () => { document.getElementById('sym-filter').value = ''; renderCoinsTable(); });
document.getElementById('vol-filter').addEventListener('change', () => loadCoins(currentExchange));
document.getElementById('btn-refresh').addEventListener('click', () => loadCoins(currentExchange));

// ── Alerts ────────────────────────────────────────────────
function loadAlertsLocal() {
  try { return JSON.parse(localStorage.getItem('cryptoTool_alerts_v2') || '[]'); } catch { return []; }
}
function saveAlertsLocal(a) {
  try { localStorage.setItem('cryptoTool_alerts_v2', JSON.stringify(a.slice(0, 100))); } catch {}
}
function updateAlertBadge() {
  const n = loadAlertsLocal().filter(a => a.isActive).length;
  const b = document.getElementById('alert-badge');
  b.textContent = n; b.classList.toggle('visible', n > 0);
}
function renderAlerts() {
  const alerts = loadAlertsLocal();
  const el     = document.getElementById('alerts-list');
  if (!alerts.length) {
    el.innerHTML = '<div class="alerts-empty">No alerts set.<br>Click a line on the chart to add one.</div>';
    return;
  }
  el.innerHTML = alerts.map(a => `
    <div class="alert-item ${a.isTriggered ? 'triggered' : 'active'}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="alert-sym">${a.symbol.replace('USDT','/USDT')}</span>
        <span style="font-size:11px">${a.isTriggered ? '✓' : '🚨'} ${a.type}</span>
      </div>
      <div class="alert-price">${fmtPrice(a.targetPrice)}</div>
      ${a.triggeredAt ? `<div style="font-size:10px;color:var(--text-lo)">Triggered: ${new Date(a.triggeredAt).toLocaleTimeString()}</div>` : ''}
      <div class="alert-actions">
        <button class="alert-btn danger" onclick="removeAlert('${a.id}')">Remove</button>
        ${!a.isTriggered ? `<button class="alert-btn" onclick="toggleAlert('${a.id}')">${a.isActive ? 'Disable' : 'Enable'}</button>` : ''}
      </div>
    </div>`).join('');
}

window.removeAlert = id => { saveAlertsLocal(loadAlertsLocal().filter(a => a.id !== id)); renderAlerts(); updateAlertBadge(); markDirty(); };
window.toggleAlert = id => {
  const all = loadAlertsLocal(), it = all.find(x => x.id === id);
  if (it) it.isActive = !it.isActive;
  saveAlertsLocal(all); renderAlerts(); updateAlertBadge();
};
document.getElementById('btn-clear-alerts').addEventListener('click', () => {
  if (confirm('Clear all alerts?')) { saveAlertsLocal([]); renderAlerts(); updateAlertBadge(); markDirty(); }
});

function playAlertSound() {
  try {
    const actx = new AudioContext();
    const osc  = actx.createOscillator();
    const gain = actx.createGain();
    osc.connect(gain); gain.connect(actx.destination);
    osc.frequency.setValueAtTime(880, actx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, actx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.3, actx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.4);
    osc.start(); osc.stop(actx.currentTime + 0.4);
  } catch {}
}

// Alert polling (2s interval, Binance price feed)
setInterval(() => {
  const active = loadAlertsLocal().filter(a => a.isActive && !a.isTriggered);
  if (!active.length) return;
  const syms = [...new Set(active.map(a => a.symbol))].slice(0, 20);
  fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbols=${encodeURIComponent(JSON.stringify(syms))}`)
    .then(r => r.json())
    .then(data => {
      const pm = {};
      (Array.isArray(data) ? data : []).forEach(t => { pm[t.symbol] = +t.price; });
      const all = loadAlertsLocal(); let changed = false;
      for (const al of all) {
        if (!al.isActive || al.isTriggered) continue;
        const p = pm[al.symbol]; if (!p) continue;
        al.lastCheckedPrice = p;
        const hit = (al.type === 'above' && p >= al.targetPrice) ||
                    (al.type === 'below' && p <= al.targetPrice);
        if (hit) {
          al.isTriggered = true; al.triggeredAt = Date.now(); al.triggerPrice = p;
          if (al.frequency === 'once') al.isActive = false;
          changed = true;
          playAlertSound();
          showToast(`🚨 ${al.symbol} ${al.type} ${fmtPrice(al.targetPrice)}`, 'success');
        }
      }
      if (changed) { saveAlertsLocal(all); renderAlerts(); updateAlertBadge(); markDirty(); }
    }).catch(() => {});
}, 2000);

// ── Trading ───────────────────────────────────────────────
let tradingCreds = null;
try { tradingCreds = JSON.parse(localStorage.getItem('cryptoTool_tradingCredentials') || 'null'); } catch {}
if (tradingCreds) {
  isAuthenticated = true;
  document.getElementById('auth-form').style.display    = 'none';
  document.getElementById('order-section').style.display = 'block';
  loadPositions();
}

document.getElementById('btn-connect').addEventListener('click', async () => {
  const key   = document.getElementById('api-key').value.trim();
  const sec   = document.getElementById('api-secret').value.trim();
  const exch  = document.getElementById('trade-exch').value;
  const errEl = document.getElementById('auth-error');
  errEl.style.display = 'none';
  if (!key || !sec) { errEl.textContent = 'Enter API key and secret'; errEl.style.display = 'block'; return; }
  const btn = document.getElementById('btn-connect');
  btn.textContent = 'Connecting…'; btn.disabled = true;
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v2/account?timestamp=${Date.now()}`, { headers: { 'X-MBX-APIKEY': key } });
    const d   = await res.json();
    if (d.code && d.code < 0) throw new Error(d.msg);
    tradingCreds = { apiKey: key, apiSecret: sec, exchange: exch };
    localStorage.setItem('cryptoTool_tradingCredentials', JSON.stringify(tradingCreds));
    isAuthenticated = true;
    document.getElementById('auth-form').style.display    = 'none';
    document.getElementById('order-section').style.display = 'block';
    showToast('Connected to ' + exch, 'success');
    loadPositions();
  } catch (e) {
    errEl.textContent = 'Connection failed: ' + e.message; errEl.style.display = 'block';
  } finally { btn.textContent = 'Connect'; btn.disabled = false; }
});

document.getElementById('btn-disconnect').addEventListener('click', () => {
  if (!confirm('Disconnect?')) return;
  localStorage.removeItem('cryptoTool_tradingCredentials');
  tradingCreds = null; isAuthenticated = false;
  document.getElementById('auth-form').style.display    = 'block';
  document.getElementById('order-section').style.display = 'none';
  document.getElementById('api-key').value    = '';
  document.getElementById('api-secret').value = '';
  showToast('Disconnected');
});

document.getElementById('btn-buy').addEventListener('click',  () => { tradeSide = 'BUY';  computeOrderPreview(); });
document.getElementById('btn-sell').addEventListener('click', () => { tradeSide = 'SELL'; computeOrderPreview(); });
document.getElementById('btn-market').addEventListener('click', () => {
  tradeMode = 'market';
  document.getElementById('btn-market').classList.add('active');
  document.getElementById('btn-limit').classList.remove('active');
  document.getElementById('limit-price-row').style.display = 'none';
});
document.getElementById('btn-limit').addEventListener('click', () => {
  tradeMode = 'limit';
  document.getElementById('btn-limit').classList.add('active');
  document.getElementById('btn-market').classList.remove('active');
  document.getElementById('limit-price-row').style.display = 'block';
});
['stop-loss','max-loss','leverage-input','limit-price'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', computeOrderPreview);
});

function computeOrderPreview() {
  if (!isAuthenticated || !currentSymbol) return;
  const preview  = document.getElementById('order-preview');
  const placeBtn = document.getElementById('btn-place-order');
  const stopVal  = parseFloat(document.getElementById('stop-loss').value);
  const maxLoss  = parseFloat(document.getElementById('max-loss').value)    || 50;
  const leverage = parseInt(document.getElementById('leverage-input').value) || 10;
  const entry    = tradeMode === 'limit'
    ? parseFloat(document.getElementById('limit-price').value) || 0
    : (chartData.length ? chartData[chartData.length - 1].close : 0);

  if (!entry || !stopVal || isNaN(stopVal) ||
      (tradeSide === 'BUY'  && stopVal >= entry) ||
      (tradeSide === 'SELL' && stopVal <= entry)) {
    preview.style.display = 'none'; placeBtn.disabled = true; return;
  }
  const diff = Math.abs(entry - stopVal);
  if (diff / entry < 0.0001) { preview.style.display = 'none'; placeBtn.disabled = true; return; }

  const qty    = maxLoss / diff;
  const posVal = qty * entry;
  const margin = posVal / leverage;
  preview.style.display = 'block';
  preview.innerHTML = `
    <div class="preview-row"><span class="preview-label">Qty</span><span class="preview-val">${qty.toFixed(4)}</span></div>
    <div class="preview-row"><span class="preview-label">Position</span><span class="preview-val">${posVal.toFixed(2)} USDT</span></div>
    <div class="preview-row"><span class="preview-label">Margin</span><span class="preview-val">${margin.toFixed(2)} USDT</span></div>
    <div class="preview-row"><span class="preview-label">Risk</span><span class="preview-val">${(qty * diff).toFixed(2)} USDT</span></div>
    <div class="preview-row"><span class="preview-label">Stop dist</span><span class="preview-val">${(diff / entry * 100).toFixed(2)}%</span></div>`;
  placeBtn.disabled = false;
}

document.getElementById('btn-set-stop-chart').addEventListener('click', () => {
  stopLossMode = true; priceCanvas.style.cursor = 'crosshair';
  showToast('Click chart to set stop loss price');
});
document.getElementById('btn-place-order').addEventListener('click', () => {
  showToast('Order placement requires live signed API connection', 'error');
});

async function loadPositions() {
  if (!tradingCreds) return;
  document.getElementById('positions-list').innerHTML =
    '<div style="color:var(--text-lo);font-size:11px;text-align:center;padding:12px">Loading…</div>';
  try {
    const res  = await fetch(`https://fapi.binance.com/fapi/v2/positionRisk?timestamp=${Date.now()}`, { headers: { 'X-MBX-APIKEY': tradingCreds.apiKey } });
    const data = await res.json();
    renderPositions(Array.isArray(data) ? data.filter(p => +p.positionAmt !== 0) : []);
  } catch (e) {
    document.getElementById('positions-list').innerHTML =
      `<div style="color:var(--bear);font-size:11px;text-align:center;padding:12px">Error: ${e.message}</div>`;
  }
}

function renderPositions(positions) {
  const el = document.getElementById('positions-list');
  if (!positions.length) {
    el.innerHTML = '<div style="color:var(--text-lo);font-size:11px;text-align:center;padding:12px">No open positions</div>';
    return;
  }
  el.innerHTML = positions.map(p => {
    const side = +p.positionAmt > 0 ? 'LONG' : 'SHORT';
    const pnl  = +p.unRealizedProfit;
    return `<div class="position-card">
      <div class="pos-header">
        <span class="pos-sym">${p.symbol.replace('USDT','/USDT')}</span>
        <span class="pos-side ${side.toLowerCase()}">${side}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:2px">
        <span style="color:var(--text-lo)">Entry: ${fmtPrice(+p.entryPrice)}</span>
        <span class="pos-pnl ${pnl >= 0 ? 'bull' : 'bear'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT</span>
      </div>
      <button class="pos-close-btn" onclick="showToast('Add signed API keys in Trade tab to place orders')">Close</button>
    </div>`;
  }).join('');
}

setInterval(loadPositions, 30000);

// ── Scanner ───────────────────────────────────────────────
document.getElementById('btn-scan-start').addEventListener('click', startScanner);
document.getElementById('btn-scan-stop').addEventListener('click',  stopScanner);

function renderScannerTable() {
  const minVol = parseFloat(document.getElementById('scan-vol').value || '20') * 1e6;
  scannerCoins = allCoins.filter(c => c.quoteVolume >= minVol);
  document.getElementById('scanner-tbody').innerHTML = scannerCoins.map((c, idx) => `
    <tr class="scanner-row-item" data-idx="${idx}" data-symbol="${c.fullSymbol}" data-exchange="${c.exchange}">
      <td>${c.symbol}</td>
      <td class="${c.priceChangePercent > 0 ? 'bull' : 'bear'}">${fmtPct(c.priceChangePercent)}</td>
      <td class="${c.volumeChange > 0 ? 'bull' : c.volumeChange < 0 ? 'bear' : 'neu'}">${c.volumeChange !== 0 ? fmtPct(c.volumeChange) : '—'}</td>
    </tr>`).join('');
  document.querySelectorAll('.scanner-row-item').forEach(r => {
    r.addEventListener('click', () => {
      scannerIndex = +r.dataset.idx;
      selectCoin(r.dataset.symbol, r.dataset.exchange);
      highlightScannerRow(scannerIndex);
    });
  });
}

function startScanner() {
  if (!scannerCoins.length) renderScannerTable();
  if (!scannerCoins.length) { showToast('Load coins first'); return; }
  document.getElementById('btn-scan-start').style.display = 'none';
  document.getElementById('btn-scan-stop').style.display  = 'inline-block';
  const secs = (parseInt(document.getElementById('scan-secs').value) || 5) * 1000;
  scannerIndex = 0; advanceScanner();
  scannerTimer = setInterval(advanceScanner, secs);
}

function stopScanner() {
  clearInterval(scannerTimer); scannerTimer = null;
  document.getElementById('btn-scan-start').style.display = 'inline-block';
  document.getElementById('btn-scan-stop').style.display  = 'none';
  document.getElementById('scan-progress').textContent    = '';
}

function advanceScanner() {
  if (!scannerCoins.length) { stopScanner(); return; }
  if (scannerIndex >= scannerCoins.length) scannerIndex = 0;
  const c = scannerCoins[scannerIndex];
  selectCoin(c.fullSymbol, c.exchange);
  highlightScannerRow(scannerIndex);
  document.getElementById('scan-progress').textContent = `${scannerIndex + 1}/${scannerCoins.length}`;
  scannerIndex++;
}

function highlightScannerRow(idx) {
  document.querySelectorAll('.scanner-row-item').forEach(r => r.classList.remove('current'));
  document.querySelector(`.scanner-row-item[data-idx="${idx}"]`)?.classList.add('current');
}

// ── Init ──────────────────────────────────────────────────
loadCoins(currentExchange);
renderAlerts();
updateAlertBadge();
if (currentSymbol) setTimeout(() => loadChart(currentSymbol, currentExchange), 400);
