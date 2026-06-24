/**
 * app.js — Crypto Trading Tool
 *
 * Code review fixes (2026-06-24):
 * - API credentials moved from localStorage → sessionStorage (cleared on tab close)
 * - renderPositions error path uses textContent instead of innerHTML
 * - manualLines restored with Number.isFinite validation on all fields
 * - All three polling intervals gated on document.visibilityState === 'visible'
 * - btn-latest classList.toggle uses optional chaining
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
let currentSymbol      = '';
let currentExchange    = 'binance';
let allCoins           = [];
let sortCol            = 'priceChangePercent';
let sortDir            = 'desc';
let wsCleanup          = null;
let scannerTimer       = null;
let scannerIndex       = 0;
let scannerCoins       = [];
let isAuthenticated    = false;
let tradeSide          = 'BUY';
let tradeMode          = 'market';
let chartData          = [];
let visibleCount       = 120;
let scrollOffset       = 0;
let rafId              = 0;
let chartDirty         = false;
let manualLines        = [];
let drawMode           = false;
let tempLine           = null;
let selectedLineId     = null;
let isDragging         = false;
let pointerStart       = null;
let pointerStartOffset = 0;
let showCrosshair      = false;
let crosshairX         = 0;
let crosshairY         = 0;
let diagLines          = [];
let activeIndicator    = 'diagonal';
let stopLossMode       = false;
let loadToken          = 0;

const MARGINS    = { top: 20, right: 80, bottom: 40, left: 10 };
const EXTRA_BARS = 5;

// Restore saved symbol (preference only — no sensitive data)
try {
  const last = JSON.parse(localStorage.getItem('cryptoTool_lastSymbol') || '{}');
  if (last.symbol) { currentSymbol = last.symbol; currentExchange = last.exchange || 'binance'; }
} catch {}

// ── Canvas setup ──────────────────────────────────────────
const priceCanvas  = document.getElementById('price-canvas');
const volumeCanvas = document.getElementById('volume-canvas');
// FIX: prevent browser swipe-scroll hijacking touch events on canvas
if (priceCanvas.parentElement)  priceCanvas.parentElement.style.touchAction  = 'none';
if (volumeCanvas.parentElement) volumeCanvas.parentElement.style.touchAction = 'none';

// Resize backing store + unconditionally reset DPR transform each frame.
// This guarantees the transform state is always known before any drawing.
function prepareCanvas(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const w   = Math.round(canvas.clientWidth  * dpr);
  const h   = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = w;
    canvas.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
}

// ── Coordinate system ─────────────────────────────────────
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

// Returns unclamped canvas-x for a timestamp — can be negative (off-screen left).
// drawRay clips to chart area so this is safe.
function ts2xFull(ts, s) {
  const ivMs    = chartData.length >= 2 ? (chartData[1].openTime - chartData[0].openTime) : 900_000;
  const dataIdx = (ts - chartData[0].openTime) / ivMs;
  const visIdx  = dataIdx - s.startIndex;
  return s.ca.x + visIdx * s.xScale + s.xScale * 0.5;
}

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

// ── Render ────────────────────────────────────────────────
function markDirty() {
  chartDirty = true;
  if (!rafId) rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (chartDirty) { chartDirty = false; renderChart(); }
  });
}

function renderChart() {
  const pw = priceCanvas.clientWidth,  ph = priceCanvas.clientHeight;
  const vw = volumeCanvas.clientWidth, vh = volumeCanvas.clientHeight;
  if (!pw || !ph) return;

  const ctx  = priceCanvas.getContext('2d');
  const vctx = volumeCanvas.getContext('2d');
  prepareCanvas(priceCanvas,  ctx);
  prepareCanvas(volumeCanvas, vctx);

  if (!chartData.length) return;
  const s = computeScale(pw, ph);

  drawGrid(ctx, s, pw, ph);
  drawCandles(ctx, s);
  drawCurrentPrice(ctx, s);
  if (activeIndicator === 'diagonal') drawDiagLines(ctx, s);
  else if (activeIndicator === 'bounce' && window.indicators?.bounce) {
    const lines = window.indicators.bounce.calculate(chartData);
    window.indicators.bounce.render(ctx, s, lines);
  } else if (activeIndicator === 'mrc' && window.indicators?.mrc) {
    const result = window.indicators.mrc.calculate(chartData);
    window.indicators.mrc.render(ctx, s, result);
  } else if (activeIndicator === 'trendline' && window.indicators?.trendline) {
    const lines = window.indicators.trendline.calculate(chartData);
    window.indicators.trendline.render(ctx, s, lines);
  }
  drawManualLines(ctx, s);
  drawAlertLines(ctx, s);
  if (stopLossMode) drawStopLossPreview(ctx, s);
  if (tempLine && tempLine.ts2) drawTempLine(ctx, s);
  if (showCrosshair && !drawMode && !stopLossMode) drawCrosshair(ctx, s, pw, ph);
  drawVolume(vctx, s, vw, vh);

  // FIX: optional chaining — safe if element is ever absent
  document.getElementById('btn-latest')?.classList.toggle('visible', scrollOffset > 10);
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

// ── Current price line ────────────────────────────────────
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

// ── Diagonal S/R lines ────────────────────────────────────
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
      drawRay(ctx, s, al.line.ts1, al.line.price1, al.line.ts2, al.line.price2, col, 1, false, al.isTriggered);
    } else {
      const y = p2y(al.targetPrice, s);
      ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1;
      if (al.isTriggered) ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(s.ca.x, y); ctx.lineTo(s.ca.x + s.ca.width, y); ctx.stroke();
      ctx.setLineDash([]); ctx.restore();
    }
  }
}

function drawStopLossPreview(ctx, s) {
  const y = crosshairY, price = y2p(y, s);
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

function drawCrosshair(ctx, s, w, h) {
  const y = crosshairY, lbl = fmtPrice(y2p(y, s)), tagW = lbl.length * 7 + 8;
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

// Draws a ray from left edge to right edge of the chart area, using
// unclamped timestamp→x coordinates so slope is always correct even
// when one anchor is scrolled off-screen.
function drawRay(ctx, s, ts1, p1, ts2, p2, color, lw = 1.5, horizontal = false, dashed = false) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  if (dashed) ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.rect(s.ca.x, s.ca.y, s.ca.width, s.ca.height); ctx.clip();
  if (horizontal) {
    const y = p2y(p1, s);
    ctx.beginPath(); ctx.moveTo(s.ca.x, y); ctx.lineTo(s.ca.x + s.ca.width, y);
  } else {
    const x1 = ts2xFull(ts1, s), y1 = p2y(p1, s);
    const x2 = ts2xFull(ts2, s), y2 = p2y(p2, s);
    const dx = x2 - x1;
    if (Math.abs(dx) < 0.001) {
      ctx.beginPath(); ctx.moveTo(s.ca.x, y1); ctx.lineTo(s.ca.x + s.ca.width, y1);
    } else {
      const slope  = (y2 - y1) / dx;
      const startX = s.ca.x, endX = s.ca.x + s.ca.width;
      ctx.beginPath();
      ctx.moveTo(startX, y1 + (startX - x1) * slope);
      ctx.lineTo(endX,   y1 + (endX   - x1) * slope);
    }
  }
  ctx.stroke();
  ctx.setLineDash([]); ctx.restore();
}

// ── Chart data loading ────────────────────────────────────
async function loadChart(symbol, exchange) {
  const myToken = ++loadToken;

  document.getElementById('overlay-placeholder').classList.add('hidden');
  document.getElementById('overlay-loading').classList.remove('hidden');
  document.getElementById('overlay-error').classList.add('hidden');
  document.getElementById('chart-title').textContent =
    symbol.replace('USDT', '/USDT') + ' · ' + currentInterval;

  if (wsCleanup) { wsCleanup(); wsCleanup = null; }

  try {
    const url = exchange === 'binance'
      ? `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${currentInterval}&limit=500`
      : `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${toBybitInterval(currentInterval)}&limit=500`;

    const res = await fetch(url);
    const raw = await res.json();
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

    // FIX: validate each restored line — drop any with non-finite numeric fields
    // to prevent NaN propagating into ts2xFull/drawRay on corrupted localStorage data.
    const rawLines = JSON.parse(localStorage.getItem(`cryptoTool_lines_${symbol}`) || '[]');
    manualLines = rawLines.filter(l =>
      l && typeof l === 'object' &&
      Number.isFinite(l.ts1) && Number.isFinite(l.price1) &&
      Number.isFinite(l.ts2) && Number.isFinite(l.price2)
    );

    if (activeIndicator === 'diagonal') diagLines = calcDiagSR(chartData);
    else resetIndicator();

    // §9.3: compute & cache 12h volume change lazily after chart load
    updateVolumeChange(symbol, chartData, currentInterval).catch(() => {});

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

// ── WebSocket kline stream ────────────────────────────────
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
      if (attempts < 5)
        reconnTimer = setTimeout(() => { attempts++; connect(); }, Math.min(5000 * Math.pow(1.5, attempts), 30000));
    };
  }
  connect();
  return () => { clearTimeout(reconnTimer); try { ws?.close(); } catch {} };
}

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

// ── REST price polling (Binance fallback / heartbeat) ─────
// Backs off when WS is delivering updates; takes over when WS is silent.
let _lastWsTime  = 0;
let _pollFailures = 0;

async function pollCurrentPrice() {
  // FIX: skip when tab is hidden — avoid hammering API in background
  if (document.visibilityState !== 'visible') return;
  if (!currentSymbol || currentExchange !== 'binance') return;
  if (!chartData.length) return;
  if (Date.now() - _lastWsTime < 1800) return; // WS is healthy, back off

  try {
    const res   = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${currentSymbol}`);
    const data  = await res.json();
    const price = parseFloat(data.price);
    if (!price || isNaN(price)) return;
    _pollFailures = 0;
    const last = chartData[chartData.length - 1];
    if (!last) return;
    const updated = { ...last, close: price };
    if (price > last.high) updated.high = price;
    if (price < last.low)  updated.low  = price;
    chartData[chartData.length - 1] = updated;
    markDirty();
  } catch { _pollFailures++; }
}

function updateCandleWithHeartbeat(candle, token) {
  _lastWsTime = Date.now();
  updateCandle(candle, token);
}

setInterval(pollCurrentPrice, 2000);

// ── Diagonal S/R ──────────────────────────────────────────
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
  function priceAt(b1, p1, b2, p2, t) { return b2 === b1 ? p1 : p1 + (p2 - p1) * (t - b1) / (b2 - b1); }
  function intersects(b1, p1, b2, p2, type) {
    for (let i = b1 + 1; i < b2; i++) {
      const lp = priceAt(b1, p1, b2, p2, i);
      if (type === 'support'    && Math.min(data[i].open, data[i].close) < lp) return true;
      if (type === 'resistance' && Math.max(data[i].open, data[i].close) > lp) return true;
    }
    return false;
  }
  const lines = []; let sc = 0, rc = 0;
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

// ── Pointer / touch events ────────────────────────────────
priceCanvas.addEventListener('pointermove', e => {
  const rect = priceCanvas.getBoundingClientRect();
  crosshairX = e.clientX - rect.left;
  crosshairY = e.clientY - rect.top;
  showCrosshair = true;
  if (drawMode && tempLine && chartData.length) {
    const s = computeScale(priceCanvas.clientWidth, priceCanvas.clientHeight);
    tempLine.ts2    = x2ts(crosshairX, s);
    tempLine.price2 = y2p(crosshairY, s);
  }
  if (pointerStart && !drawMode) {
    const dx = e.clientX - pointerStart.x;
    if (Math.abs(dx) > 5) {
      isDragging = true;
      const s   = computeScale(priceCanvas.clientWidth, priceCanvas.clientHeight);
      const max = Math.max(0, chartData.length - visibleCount);
      // Drag right (positive dx) → older candles → offset increases
      scrollOffset = Math.max(0, Math.min(max, pointerStartOffset + Math.round(dx / s.xScale)));
    }
  }
  markDirty();
});

priceCanvas.addEventListener('pointerdown', e => {
  priceCanvas.setPointerCapture(e.pointerId);
  pointerStart = { x: e.clientX, y: e.clientY };
  pointerStartOffset = scrollOffset;
  isDragging = false;
});

priceCanvas.addEventListener('pointerup', e => {
  priceCanvas.releasePointerCapture(e.pointerId);
  if (!isDragging) handleChartClick(e);
  pointerStart = null; isDragging = false;
});

priceCanvas.addEventListener('pointercancel', () => { pointerStart = null; isDragging = false; });
priceCanvas.addEventListener('pointerleave',  () => { showCrosshair = false; markDirty(); });

priceCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  const max    = Math.max(0, chartData.length - visibleCount);
  scrollOffset = Math.max(0, Math.min(max, scrollOffset + (e.deltaY > 0 ? 15 : -15)));
  markDirty();
}, { passive: false });

priceCanvas.addEventListener('dblclick', () => { scrollOffset = 0; markDirty(); });

// ── Click / tap ───────────────────────────────────────────
function handleChartClick(e) {
  const rect = priceCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  if (!chartData.length) return;
  const s = computeScale(priceCanvas.clientWidth, priceCanvas.clientHeight);

  if (stopLossMode) {
    const price = y2p(y, s);
    document.getElementById('stop-loss').value = price.toFixed(6);
    stopLossMode = false; priceCanvas.style.cursor = 'default';
    showToast('Stop loss set: ' + fmtPrice(price));
    computeOrderPreview(); markDirty(); return;
  }

  if (drawMode) {
    if (!tempLine) {
      tempLine = { ts1: x2ts(x, s), price1: y2p(y, s), ts2: x2ts(x, s), price2: y2p(y, s) };
    } else {
      const ts2 = x2ts(x, s), pr2 = y2p(y, s);
      const isH = Math.abs(pr2 - tempLine.price1) / tempLine.price1 < 0.001;
      manualLines.push({ id: Date.now().toString(), ts1: tempLine.ts1, price1: tempLine.price1, ts2, price2: isH ? tempLine.price1 : pr2, isHorizontal: isH });
      selectedLineId = manualLines[manualLines.length - 1].id;
      saveLinesLocal(); tempLine = null; drawMode = false;
      document.getElementById('btn-draw').classList.remove('active');
      priceCanvas.style.cursor = 'default'; markDirty();
    }
    return;
  }

  // Hit-test lines
  for (let i = manualLines.length - 1; i >= 0; i--) {
    const line = manualLines[i];
    const x1 = ts2xFull(line.ts1, s), y1 = p2y(line.price1, s);
    const x2 = ts2xFull(line.ts2, s), y2 = p2y(line.price2, s);
    let dist;
    if (line.isHorizontal) {
      dist = Math.abs(y - y1);
    } else {
      const dx = x2 - x1, dy = y2 - y1;
      const t  = (dx * dx + dy * dy) > 0 ? ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy) : 0;
      dist = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
    }
    if (dist < 8) { selectedLineId = line.id; showLineStatus(line); markDirty(); return; }
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
  const alerts = loadAlertsLocal();
  alerts.push({ id: Date.now().toString(), symbol: currentSymbol, type: 'cross-any', targetPrice: price,
    line: line.isHorizontal ? null : { ts1: line.ts1, price1: line.price1, ts2: line.ts2, price2: line.price2 },
    isActive: true, isTriggered: false, frequency: 'once', createdAt: Date.now() });
  saveAlertsLocal(alerts); renderAlerts(); updateAlertBadge();
  showToast('Alert created at ' + fmtPrice(price));
  document.getElementById('line-status').classList.remove('visible');
};

function saveLinesLocal() {
  try { localStorage.setItem(`cryptoTool_lines_${currentSymbol}`, JSON.stringify(manualLines)); } catch {}
}

// ── Controls ──────────────────────────────────────────────
document.getElementById('btn-draw').addEventListener('click', () => {
  drawMode = !drawMode; tempLine = null;
  document.getElementById('btn-draw').classList.toggle('active', drawMode);
  priceCanvas.style.cursor = drawMode ? 'crosshair' : 'default'; markDirty();
});
document.getElementById('btn-clear').addEventListener('click', () => {
  if (!currentSymbol || !confirm('Clear all lines for ' + currentSymbol + '?')) return;
  manualLines = []; selectedLineId = null; saveLinesLocal();
  document.getElementById('line-status').classList.remove('visible'); markDirty();
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
  resetIndicator();
  // Show MRC settings button if MRC active
  const mrcBtn = document.getElementById('btn-mrc-settings');
  if (mrcBtn) mrcBtn.style.display = activeIndicator === 'mrc' ? 'inline-flex' : 'none';
  markDirty();
});

function resetIndicator() {
  window.indicators?.bounce?.reset();
  window.indicators?.mrc?.reset();
  window.indicators?.trendline?.reset();
}

// MRC settings button — injected next to indicator dropdown
(function() {
  const sel = document.getElementById('select-indicator');
  const btn = document.createElement('button');
  btn.id = 'btn-mrc-settings'; btn.className = 'chart-btn'; btn.title = 'MRC Settings';
  btn.textContent = '⚙'; btn.style.display = 'none';
  btn.addEventListener('click', () => window.indicators?.mrc?.openSettings());
  sel.insertAdjacentElement('afterend', btn);
})();

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  switch (e.key) {
    case 'Escape':
      drawMode = false; tempLine = null; stopLossMode = false; selectedLineId = null;
      document.getElementById('btn-draw').classList.remove('active');
      priceCanvas.style.cursor = 'default';
      document.getElementById('line-status').classList.remove('visible'); markDirty(); break;
    case 'Delete': case 'Backspace': if (selectedLineId) window.deleteLine(selectedLineId); break;
    case '+': case '=': visibleCount = Math.max(20,  visibleCount - 30); markDirty(); break;
    case '-':            visibleCount = Math.min(800, visibleCount + 30); markDirty(); break;
    case 'ArrowLeft':  scrollOffset = Math.min(Math.max(0, chartData.length - visibleCount), scrollOffset + 5); markDirty(); break;
    case 'ArrowRight': scrollOffset = Math.max(0, scrollOffset - 5); markDirty(); break;
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
    const data    = await fetch(url).then(r => r.json());
    const minVol  = parseFloat(document.getElementById('vol-filter').value || '20') * 1e6;
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
    // Do NOT call loadChart here — would bump loadToken and orphan the active WS
  } catch (e) {
    showToast('Failed to load coins: ' + e.message, 'error');
  } finally { btn.classList.remove('spinning'); }
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
  document.getElementById('coins-tbody').innerHTML = getFilteredSorted().map(c => {
    const cc = c.priceChangePercent > 0 ? 'bull' : c.priceChangePercent < 0 ? 'bear' : 'neu';
    const vc = c.volumeChange > 0 ? 'bull' : c.volumeChange < 0 ? 'bear' : 'neu';
    return `<tr class="coin-row ${c.fullSymbol === currentSymbol ? 'selected' : ''}" data-symbol="${c.fullSymbol}" data-exchange="${c.exchange}">
      <td><span class="sym">${c.symbol}</span></td>
      <td>${fmtPrice(c.lastPrice)}</td>
      <td class="${cc}">${fmtPct(c.priceChangePercent)}</td>
      <td class="${vc}">${c.volumeChange !== 0 ? fmtPct(c.volumeChange) : '—'}</td>
      <td>${fmtVol(c.quoteVolume)}</td>
    </tr>`;
  }).join('');
  document.querySelectorAll('.coin-row').forEach(r =>
    r.addEventListener('click', () => selectCoin(r.dataset.symbol, r.dataset.exchange)));
}

function selectCoin(symbol, exchange) {
  currentSymbol = symbol; currentExchange = exchange;
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
  loadCoins(currentExchange).then(() => { if (currentSymbol) loadChart(currentSymbol, currentExchange); });
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
  b?.classList.toggle('visible', n > 0);
  if (b) b.textContent = n;
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
    const actx = new AudioContext(), osc = actx.createOscillator(), gain = actx.createGain();
    osc.connect(gain); gain.connect(actx.destination);
    osc.frequency.setValueAtTime(880, actx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, actx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.3, actx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.4);
    osc.start(); osc.stop(actx.currentTime + 0.4);
  } catch {}
}

// FIX: skip alert polling when tab is hidden
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  const active = loadAlertsLocal().filter(a => a.isActive && !a.isTriggered);
  if (!active.length) return;
  const syms = [...new Set(active.map(a => a.symbol))].slice(0, 20);
  fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbols=${encodeURIComponent(JSON.stringify(syms))}`)
    .then(r => r.json()).then(data => {
      const pm = {};
      (Array.isArray(data) ? data : []).forEach(t => { pm[t.symbol] = +t.price; });
      const all = loadAlertsLocal(); let changed = false;
      for (const al of all) {
        if (!al.isActive || al.isTriggered) continue;
        const p = pm[al.symbol]; if (!p) continue;
        al.lastCheckedPrice = p;
        const hit = (al.type === 'above' && p >= al.targetPrice) || (al.type === 'below' && p <= al.targetPrice);
        if (hit) {
          al.isTriggered = true; al.triggeredAt = Date.now(); al.triggerPrice = p;
          if (al.frequency === 'once') al.isActive = false;
          changed = true; playAlertSound();
          notifySwAlert(al, p);
          showToast(`🚨 ${al.symbol} ${al.type} ${fmtPrice(al.targetPrice)}`, 'success');
        }
      }
      if (changed) { saveAlertsLocal(all); renderAlerts(); updateAlertBadge(); markDirty(); }

      // Feed prices to trailing stop engine
      if (tradingCreds && window.trading?.trailingStop) {
        for (const [sym, price] of Object.entries(pm)) {
          if (window.trading.trailingStop.get(sym)) {
            window.trading.trailingStop.onPriceUpdate(sym, price, tradingCreds);
          }
        }
      }
    }).catch(() => {});
}, 2000);

// ── Trading ───────────────────────────────────────────────
// FIX: credentials stored in sessionStorage — cleared when tab/browser closes,
// never persisted to disk. The UI says "stored locally" which is accurate for
// the session; no credentials are sent to any server other than the exchange.
const CREDS_KEY = 'cryptoTool_sessionCreds';
let tradingCreds = null;
try { tradingCreds = JSON.parse(sessionStorage.getItem(CREDS_KEY) || 'null'); } catch {}

if (tradingCreds) {
  isAuthenticated = true;
  window.trading?.setCreds(tradingCreds);
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
    // FIX: sessionStorage — not persisted across browser restarts
    sessionStorage.setItem(CREDS_KEY, JSON.stringify(tradingCreds));
    // Wire trading module
    window.trading?.setCreds(tradingCreds);
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
  sessionStorage.removeItem(CREDS_KEY);
  tradingCreds = null; isAuthenticated = false;
  document.getElementById('auth-form').style.display    = 'block';
  document.getElementById('order-section').style.display = 'none';
  document.getElementById('api-key').value = ''; document.getElementById('api-secret').value = '';
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
['stop-loss','max-loss','leverage-input','limit-price'].forEach(id =>
  document.getElementById(id)?.addEventListener('input', computeOrderPreview));

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
      (tradeSide === 'BUY' && stopVal >= entry) ||
      (tradeSide === 'SELL' && stopVal <= entry)) {
    preview.style.display = 'none'; placeBtn.disabled = true; return;
  }
  const diff = Math.abs(entry - stopVal);
  if (diff / entry < 0.0001) { preview.style.display = 'none'; placeBtn.disabled = true; return; }

  const qty = maxLoss / diff, posVal = qty * entry, margin = posVal / leverage;
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
document.getElementById('btn-place-order').addEventListener('click', async () => {
  if (!tradingCreds || !currentSymbol) return;
  const btn      = document.getElementById('btn-place-order');
  const stopVal  = parseFloat(document.getElementById('stop-loss').value);
  const maxLoss  = parseFloat(document.getElementById('max-loss').value) || 50;
  const leverage = parseInt(document.getElementById('leverage-input').value) || 10;
  const type     = tradeMode === 'limit' ? 'LIMIT' : 'MARKET';
  const price    = type === 'LIMIT' ? parseFloat(document.getElementById('limit-price').value) : 0;

  if (!stopVal || isNaN(stopVal)) { showToast('Set a stop loss price first', 'error'); return; }
  btn.textContent = 'Placing…'; btn.disabled = true;
  try {
    const result = await window.trading.placeOrder({
      symbol: currentSymbol, side: tradeSide, type, price,
      stopLoss: stopVal, maxLoss, leverage, creds: tradingCreds,
    });
    showToast(`✅ Order placed — qty ${result.qty.toFixed(4)}, risk ${result.actRisk.toFixed(2)} USDT${result.stopErr ? ' (stop failed: ' + result.stopErr + ')' : ''}`, 'success');
    document.getElementById('stop-loss').value = '';
    computeOrderPreview();
    await refreshPositionsAndOrders();
  } catch (e) {
    showToast('Order failed: ' + e.message, 'error');
  } finally {
    btn.textContent = 'Place Order'; btn.disabled = false;
  }
});

// FIX: skip position polling when tab is hidden
async function loadPositions() {
  if (!tradingCreds) return;
  document.getElementById('positions-list').innerHTML =
    '<div style="color:var(--text-lo);font-size:11px;text-align:center;padding:12px">Loading…</div>';
  try {
    const positions = await window.trading.getPositions(tradingCreds);
    renderPositions(positions);
  } catch (e) {
    // FIX: use textContent to avoid XSS via error message from Binance HTML error pages
    const el = document.getElementById('positions-list');
    el.innerHTML = '';
    const div = document.createElement('div');
    div.style.cssText = 'color:var(--bear);font-size:11px;text-align:center;padding:12px';
    div.textContent = 'Error: ' + e.message;
    el.appendChild(div);
  }
}

function renderPositions(positions) {
  const el = document.getElementById('positions-list');
  if (!positions.length) {
    el.innerHTML = '<div style="color:var(--text-lo);font-size:11px;text-align:center;padding:12px">No open positions</div>';
    return;
  }
  el.innerHTML = positions.map(p => {
    const pnl     = p.unRealizedProfit;
    const tsConf  = window.trading?.trailingStop?.get(p.symbol);
    const tsLabel = tsConf ? `TS L${tsConf.currentLevel} 🔒${fmtPrice(tsConf.currentStop)}` : '';
    return `<div class="position-card">
      <div class="pos-header">
        <span class="pos-sym">${p.symbol.replace('USDT','/USDT')}</span>
        <span class="pos-side ${p.side.toLowerCase()}">${p.side}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:2px">
        <span style="color:var(--text-lo)">Entry: ${fmtPrice(p.entryPrice)}</span>
        <span class="pos-pnl ${pnl >= 0 ? 'bull' : 'bear'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:2px;font-size:10px;color:var(--text-lo)">
        <span>Qty: ${p.positionAmt} · Lev: ${p.leverage}x</span>
        ${tsLabel ? `<span style="color:var(--accent)">${tsLabel}</span>` : ''}
      </div>
      <div style="display:flex;gap:4px;margin-top:6px">
        <button class="pos-close-btn" style="flex:1" onclick="window.doClosePosition('${p.symbol}','${p.side}',${p.positionAmt})">Close</button>
        ${!tsConf ? `<button class="pos-close-btn" style="flex:1;border-color:var(--accent);color:var(--accent)" onclick="window.doEnableTrailingStop('${p.symbol}','${p.side}',${p.positionAmt},${p.entryPrice})">Trail</button>` : `<button class="pos-close-btn" style="flex:1" onclick="window.doDisableTrailingStop('${p.symbol}')">Stop TS</button>`}
      </div>
    </div>`;
  }).join('');
}

async function loadOpenOrders(symbol) {
  if (!tradingCreds || !symbol) return;
  const el = document.getElementById('orders-list');
  el.innerHTML = '<div style="color:var(--text-lo);font-size:11px;text-align:center;padding:8px">Loading…</div>';
  try {
    const orders = await window.trading.getOpenOrders(symbol, tradingCreds);
    if (!orders.length) {
      el.innerHTML = '<div style="color:var(--text-lo);font-size:11px;text-align:center;padding:8px">No open orders</div>';
      return;
    }
    el.innerHTML = orders.map(o => `
      <div class="position-card" style="margin-bottom:4px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-family:var(--font-mono);font-size:11px;font-weight:600">${o.side} ${o.type}</span>
          <button class="pos-close-btn" onclick="window.doCancelOrder('${o.symbol}','${o.orderId}')">Cancel</button>
        </div>
        <div style="font-size:10px;color:var(--text-lo);margin-top:2px">Qty: ${o.qty} · Price: ${fmtPrice(o.price || o.stopPrice)}</div>
      </div>`).join('');
  } catch {
    el.innerHTML = '<div style="color:var(--text-lo);font-size:11px;text-align:center;padding:8px">—</div>';
  }
}

async function refreshPositionsAndOrders() {
  await loadPositions();
  if (currentSymbol) await loadOpenOrders(currentSymbol);
}

// Position action handlers
window.doClosePosition = async (symbol, side, qty) => {
  if (!confirm(`Close ${side} ${symbol} (${qty})?`)) return;
  try {
    await window.trading.closePosition(symbol, side, qty, tradingCreds);
    showToast(`Position ${symbol} closed`, 'success');
    await refreshPositionsAndOrders();
  } catch (e) { showToast('Close failed: ' + e.message, 'error'); }
};

window.doCancelOrder = async (symbol, orderId) => {
  try {
    await window.trading.cancelOrder(symbol, orderId, tradingCreds);
    showToast('Order cancelled', 'success');
    await refreshPositionsAndOrders();
  } catch (e) { showToast('Cancel failed: ' + e.message, 'error'); }
};

window.doEnableTrailingStop = async (symbol, side, qty, entry) => {
  const riskInput = prompt(`Enable trailing stop for ${symbol} ${side}\nEnter 1R risk amount in USDT:`, '50');
  if (!riskInput) return;
  const R = parseFloat(riskInput);
  if (isNaN(R) || R <= 0) { showToast('Invalid risk amount', 'error'); return; }
  window.trading.trailingStop.enable({ symbol, side, positionAmt: qty, entryPrice: entry }, R);
  showToast(`Trailing stop enabled for ${symbol} (1R = ${R} USDT)`, 'success');
  renderPositions(await window.trading.getPositions(tradingCreds));
};

window.doDisableTrailingStop = (symbol) => {
  window.trading.trailingStop.disable(symbol);
  showToast(`Trailing stop disabled for ${symbol}`);
  loadPositions();
};

// Wire trading module to trailing stop price updates
window.trading.onLevelAdvance = (symbol, level, stopPrice) => {
  if (level > 0) showToast(`🎯 ${symbol}: Trail level ${level} — stop now at ${fmtPrice(stopPrice)}`, 'success');
};
window.trading.onStopUpdate = (symbol, stopPrice) => {
  showToast(`🔒 ${symbol}: Stop updated to ${fmtPrice(stopPrice)}`);
};

setInterval(() => {
  if (document.visibilityState === 'visible') loadPositions();
}, 30000);

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
  document.querySelectorAll('.scanner-row-item').forEach(r =>
    r.addEventListener('click', () => { scannerIndex = +r.dataset.idx; selectCoin(r.dataset.symbol, r.dataset.exchange); highlightScannerRow(scannerIndex); }));
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
// Load saved symbol once on startup (intentionally not called from loadCoins)
if (currentSymbol) setTimeout(() => loadChart(currentSymbol, currentExchange), 400);

// ── Service Worker registration ───────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    console.log('[SW] Registered:', reg.scope);
  }).catch(err => console.warn('[SW] Registration failed:', err));

  // Listen for SW → main thread messages (e.g. FOCUS_SYMBOL from notification click)
  navigator.serviceWorker.addEventListener('message', ev => {
    const { type, payload } = ev.data || {};
    if (type === 'FOCUS_SYMBOL' && payload?.symbol) {
      selectCoin(payload.symbol, currentExchange);
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.querySelector('[data-tab="alerts"]').classList.add('active');
      document.getElementById('tab-alerts').classList.add('active');
    }
  });
}

// ── Notify SW when an alert fires ────────────────────────
function notifySwAlert(alert, price) {
  if (!navigator.serviceWorker?.controller) return;
  navigator.serviceWorker.controller.postMessage({
    type: 'ALERT_FIRE',
    payload: {
      id: alert.id, symbol: alert.symbol,
      alertType: alert.type, price, targetPrice: alert.targetPrice,
    },
  });
}

// ── 12h Volume Change (§9.3) ──────────────────────────────
// IndexedDB cache keyed by symbol_interval, TTL 12h
const VC_STORE = 'volumeChanges';
const VC_TTL   = 12 * 60 * 60 * 1000;
let   _vcDb    = null;

async function vcDbOpen() {
  if (_vcDb) return _vcDb;
  return new Promise((res, rej) => {
    const req = indexedDB.open('cryptoToolVC', 1);
    req.onupgradeneeded = () => req.result.createObjectStore(VC_STORE, { keyPath: 'id' });
    req.onsuccess = () => { _vcDb = req.result; res(_vcDb); };
    req.onerror   = () => rej(req.error);
  });
}

async function vcGet(symbol, interval) {
  try {
    const db = await vcDbOpen();
    return new Promise(res => {
      const req = db.transaction(VC_STORE).objectStore(VC_STORE).get(`${symbol}_${interval}`);
      req.onsuccess = () => {
        const e = req.result;
        res(e && Date.now() - e.ts < VC_TTL ? e.value : null);
      };
      req.onerror = () => res(null);
    });
  } catch { return null; }
}

async function vcSet(symbol, interval, value) {
  try {
    const db = await vcDbOpen();
    const tx = db.transaction(VC_STORE, 'readwrite');
    tx.objectStore(VC_STORE).put({ id: `${symbol}_${interval}`, value, ts: Date.now() });
  } catch {}
}

function compute12hVolumeChange(candles, interval) {
  const ivMs      = intervalMs(interval);
  const closed    = candles.filter(c => c.volume > 0);
  if (!closed.length) return null;

  const latestTime = closed[closed.length - 1].openTime;
  const last12h    = closed.filter(c => c.openTime >= latestTime - VC_TTL && c.openTime < latestTime);
  const prev12h    = closed.filter(c => c.openTime >= latestTime - 2 * VC_TTL && c.openTime < latestTime - VC_TTL);

  const expected = Math.floor(VC_TTL / ivMs);
  const minBars  = Math.max(3, Math.floor(expected * 0.25));
  if (last12h.length < minBars || prev12h.length < minBars) return null;

  const volA = last12h.reduce((s, c) => s + c.volume, 0);
  const volB = prev12h.reduce((s, c) => s + c.volume, 0);
  if (volB === 0) return null;
  return (volA - volB) / volB * 100;
}

async function updateVolumeChange(symbol, candles, interval) {
  // Check cache first
  let vc = await vcGet(symbol, interval);
  if (vc === null) {
    vc = compute12hVolumeChange(candles, interval);
    if (vc !== null) await vcSet(symbol, interval, vc);
  }
  if (vc === null) return;

  // Update the allCoins entry
  const coin = allCoins.find(c => c.fullSymbol === symbol);
  if (coin) {
    coin.volumeChange = vc;
    // Patch the table cell in-place
    const row = document.querySelector(`.coin-row[data-symbol="${symbol}"]`);
    if (row) {
      const cells = row.querySelectorAll('td');
      if (cells[3]) {
        cells[3].className = vc > 0 ? 'bull' : vc < 0 ? 'bear' : 'neu';
        cells[3].textContent = fmtPct(vc);
      }
    }
  }
}
