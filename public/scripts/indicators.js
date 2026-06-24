/**
 * indicators.js — Bounce S/R, Mean Reversion Channel, Trendline Scanner
 * Per CLONE_SPECIFICATION §8.3, §8.4, §8.5
 *
 * Each indicator exports: calculate(data) → lines[], render(ctx, s, lines), label
 * All share the same drawRay helper from app.js (passed in via window scope).
 */

'use strict';

// ── Shared pivot detection ─────────────────────────────────────────────────────
// Returns { lows: [{index, price, strength}], highs: [{index, price, strength}] }
function detectPivots(data, halfRes, startIdx) {
  const lows = [], highs = [];
  const end  = data.length - halfRes;
  for (let i = Math.max(halfRes, startIdx || 0); i < end; i++) {
    let isL = true, isH = true;
    for (let j = i - halfRes; j <= i + halfRes; j++) {
      if (j === i || j < 0 || j >= data.length) continue;
      if (data[j].low  <= data[i].low)  isL = false;
      if (data[j].high >= data[i].high) isH = false;
    }
    if (isL || isH) {
      // Strength = count of nearby bars within 0.1% of this extreme
      let strL = 0, strH = 0;
      for (let k = Math.max(0, i - 20); k <= Math.min(data.length - 1, i + 20); k++) {
        if (k === i) continue;
        if (isL && Math.abs(data[k].low  - data[i].low)  / data[i].low  < 0.001) strL++;
        if (isH && Math.abs(data[k].high - data[i].high) / data[i].high < 0.001) strH++;
      }
      if (isL) lows.push({ index: i, price: data[i].low,  strength: strL });
      if (isH) highs.push({ index: i, price: data[i].high, strength: strH });
    }
  }
  return { lows, highs };
}

// Interpolate line value at a bar index
function lineValueAt(bar1, p1, bar2, p2, targetBar) {
  if (bar2 === bar1) return p1;
  return p1 + (p2 - p1) * (targetBar - bar1) / (bar2 - bar1);
}

// ══════════════════════════════════════════════════════════════════════════════
// §8.3  BOUNCE S/R
// ══════════════════════════════════════════════════════════════════════════════
const BOUNCE_PARAMS = {
  minTouches: 3, lookbackBars: 300, touchTolerance: 0.002,
  minBarsBetweenTouches: 5, maxLines: 4, minLineQuality: 2.0,
  recentTouchBonus: 1.5, recentBarsThreshold: 50,
  breakConfirmationBars: 5, breakThreshold: 0.001,
  recalculateInterval: 20, linePersistenceTime: 100,
};

let _bounceLinesCache  = null;
let _bounceLastLen     = 0;
let _bounceLastCalcLen = 0;

function calculateBounce(data) {
  const p      = BOUNCE_PARAMS;
  const len    = data.length;
  const isFullRecalc =
    !_bounceLinesCache ||
    Math.abs(len - _bounceLastCalcLen) > 50 ||
    (len - _bounceLastLen) >= p.recalculateInterval;

  _bounceLastLen = len;

  if (!isFullRecalc && _bounceLinesCache) {
    // Incremental update: just recompute currentPrice and break status
    _bounceLinesCache = _bounceLinesCache.filter(l => {
      const cur = lineValueAt(l.bar1, l.price1, l.bar2, l.price2, len - 1);
      if (Math.abs(cur - data[len-1].close) / data[len-1].close > 0.10) return false;
      l.currentPrice = cur;
      const recent = data.slice(Math.max(0, len - p.breakConfirmationBars));
      const breakCount = recent.filter(c =>
        l.subtype === 'support'    ? c.close < cur - cur * p.breakThreshold
                                   : c.close > cur + cur * p.breakThreshold
      ).length;
      if (breakCount / recent.length >= 0.7) { l.broken = true; l.brokenAt = len - 1; }
      if (l.broken && (len - l.brokenAt) > p.linePersistenceTime) return false;
      return true;
    });
    return _bounceLinesCache;
  }

  _bounceLastCalcLen = len;
  const startIdx = Math.max(0, len - p.lookbackBars);
  const { lows, highs } = detectPivots(data, 5, startIdx);

  // Score pivots by 0.7*strength + 0.3*recencyRatio
  const recencyRatio = p => (p.index - startIdx) / Math.max(1, len - 1 - startIdx);
  const scoreP = p => 0.7 * p.strength + 0.3 * recencyRatio(p);

  function buildLines(pivots, subtype) {
    const sorted = [...pivots].sort((a, b) => scoreP(b) - scoreP(a));
    const used   = new Set();
    const lines  = [];

    for (const base of sorted) {
      if (used.has(base.index)) continue;
      const aligned = [];
      for (const other of sorted) {
        if (other.index === base.index || used.has(other.index)) continue;
        const priceDiff = Math.abs(other.price - base.price) / base.price;
        const barGap    = Math.abs(other.index - base.index);
        const slope     = barGap > 0 ? Math.abs((other.price - base.price) / barGap) / base.price : 0;
        const isAligned =
          priceDiff < p.touchTolerance ||
          (barGap > p.minBarsBetweenTouches && slope < 0.001);
        if (isAligned) aligned.push(other);
      }
      if (aligned.length < p.minTouches - 1) continue;

      // Least squares fit
      const pts = [base, ...aligned].sort((a, b) => a.index - b.index);
      const n   = pts.length;
      let sx = 0, sy = 0, sxy = 0, sx2 = 0;
      for (const pt of pts) { sx += pt.index; sy += pt.price; sxy += pt.index * pt.price; sx2 += pt.index * pt.index; }
      const denom = n * sx2 - sx * sx;
      const slope  = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
      const intercept = (sy - slope * sx) / n;
      const lv = b => slope * b + intercept;

      // Count touches and bounces
      let touchCount = 0, bounceCount = 0, lastTouchBar = -999;
      const touchBars = [];
      for (let i = startIdx; i < len; i++) {
        const lval     = lv(i);
        const extreme  = subtype === 'support' ? data[i].low : data[i].high;
        const diff     = Math.abs(extreme - lval) / Math.max(1e-8, lval);
        if (diff < p.touchTolerance && i - lastTouchBar >= p.minBarsBetweenTouches) {
          touchCount++; lastTouchBar = i; touchBars.push(i);
          // Check bounce
          const end = Math.min(len, i + p.breakConfirmationBars + 1);
          if (subtype === 'support') {
            const maxH = Math.max(...data.slice(i, end).map(c => c.high));
            if (maxH > extreme * 1.002) bounceCount++;
          } else {
            const minL = Math.min(...data.slice(i, end).map(c => c.low));
            if (minL < extreme * 0.998) bounceCount++;
          }
        }
      }
      if (touchCount < p.minTouches) continue;

      // Quality score
      const recentBonus = touchBars.some(b => b >= len - p.recentBarsThreshold) ? p.recentTouchBonus * 2 : 0;
      let distBonus = 0;
      if (touchBars.length >= 3) {
        const gaps = touchBars.slice(1).map((b, i) => b - touchBars[i]);
        const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        distBonus = Math.min(avgGap / 10, 2);
      }
      const quality = 3 * bounceCount + touchCount + recentBonus + distBonus;
      if (quality < p.minLineQuality) continue;

      // Conflict check: skip if within 0.2% of an existing line
      const curP = lv(len - 1);
      if (lines.some(l => Math.abs(l.currentPrice - curP) / curP < 0.002)) continue;

      pts.forEach(pt => used.add(pt.index));
      lines.push({
        bar1: pts[0].index, price1: pts[0].price,
        bar2: pts[pts.length - 1].index, price2: pts[pts.length - 1].price,
        ts1: data[pts[0].index].openTime, ts2: data[pts[pts.length - 1].index].openTime,
        subtype, quality, touchCount, bounceCount, currentPrice: curP,
        slope, intercept, broken: false, brokenAt: -1,
      });
      if (lines.length >= p.maxLines) break;
    }
    return lines.sort((a, b) => b.quality - a.quality).slice(0, p.maxLines);
  }

  _bounceLinesCache = [
    ...buildLines(lows, 'support'),
    ...buildLines(highs, 'resistance'),
  ];
  return _bounceLinesCache;
}

function renderBounce(ctx, s, lines) {
  for (const line of lines) {
    if (line.broken) {
      ctx.save(); ctx.globalAlpha = 0.35;
    }
    const color = line.subtype === 'support' ? '#10b981' : '#f87171';
    const lw    = line.quality >= 5 ? 2 : 1.5;
    _drawRayFromBars(ctx, s, line.bar1, line.price1, line.bar2, line.price2, color, lw, line.broken);

    // Strength label at right edge
    const y   = p2y(line.currentPrice, s);
    const lbl = line.bounceCount >= 5 ? '★★★' : line.bounceCount >= 3 ? '★★' : '★';
    ctx.fillStyle = color; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(`${line.bounceCount}✦ ${lbl}`, s.ca.x + s.ca.width + 2, y - 2);

    if (line.broken) ctx.restore();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// §8.4  MEAN REVERSION CHANNEL (MRC)
// ══════════════════════════════════════════════════════════════════════════════
let _mrcParams = {
  lookbackPeriod: 200,
  innerMultiplier: 1.0,
  outerMultiplier: 2.415,
  displayZone: true,
  zoneTransparency: 60,
  gradientSize: 0.5,
  gradientSteps: 8,
};
let _mrcResult = null;
let _mrcSettingsOpen = false;

function superSmooth(src, length) {
  const a1 = Math.exp(-Math.SQRT2 * Math.PI / length);
  const b1 = 2 * a1 * Math.cos(Math.SQRT2 * Math.PI / length);
  const c2 = b1, c3 = -a1 * a1, c1 = 1 - c2 - c3;
  const ss = new Array(src.length).fill(0);
  ss[0] = src[0];
  if (src.length > 1) ss[1] = src[1];
  for (let i = 2; i < src.length; i++)
    ss[i] = c1 * src[i] + c2 * ss[i-1] + c3 * ss[i-2];
  return ss;
}

function calculateMRC(data) {
  const p = _mrcParams;
  if (data.length < p.lookbackPeriod) return null;

  const hlc3 = data.map(c => (c.high + c.low + c.close) / 3);
  const tr   = data.map((c, i) => {
    if (i === 0) return c.high - c.low;
    return Math.max(c.high - c.low, Math.abs(c.high - data[i-1].close), Math.abs(c.low - data[i-1].close));
  });

  const meanArr  = superSmooth(hlc3, p.lookbackPeriod);
  const rangeArr = superSmooth(tr,   p.lookbackPeriod);
  const mult  = Math.PI * p.innerMultiplier;
  const mult2 = Math.PI * p.outerMultiplier;

  const last   = data.length - 1;
  const mean   = meanArr[last];
  const range  = rangeArr[last];
  const upper1 = mean + range * mult,  lower1 = mean - range * mult;
  const upper2 = mean + range * mult2, lower2 = mean - range * mult2;

  // Condition classification
  const lastHigh = data[last].high, lastLow = data[last].low;
  const zoneEdge = range * p.gradientSize * 4;
  let condition = 'Near Mean';
  if (lastLow > upper2 + zoneEdge)       condition = 'Overbought (Strong)';
  else if (lastLow > upper2)             condition = 'Overbought (Weak)';
  else if (lastHigh > upper1)            condition = 'Price Above Mean';
  else if (lastLow < lower2 - zoneEdge)  condition = 'Oversold (Strong)';
  else if (lastLow < lower2)             condition = 'Oversold (Weak)';
  else if (lastHigh < lower1)            condition = 'Price Below Mean';

  _mrcResult = { meanArr, rangeArr, mult, mult2, mean, range, upper1, lower1, upper2, lower2, condition, last };
  return _mrcResult;
}

function renderMRC(ctx, s, result) {
  if (!result) return;
  const { meanArr, rangeArr, mult, mult2, mean, range, upper1, lower1, upper2, lower2, condition } = result;
  const p  = _mrcParams;
  const len = meanArr.length;

  // Gradient zones
  if (p.displayZone) {
    const alpha = (1 - p.zoneTransparency / 100) * 0.5;
    for (let step = 0; step < p.gradientSteps; step++) {
      const frac   = (step + 1) / p.gradientSteps * p.gradientSize;
      const fadeA  = alpha * (1 - step / p.gradientSteps);
      // Upper zone (overbought)
      const zu1 = upper2 + range * frac, zu2 = upper2 + range * (frac + 1 / p.gradientSteps * p.gradientSize);
      ctx.save(); ctx.globalAlpha = fadeA;
      ctx.fillStyle = '#f87171';
      ctx.fillRect(s.ca.x, p2y(zu2, s), s.ca.width, Math.max(1, p2y(zu1, s) - p2y(zu2, s)));
      // Lower zone (oversold)
      const zl1 = lower2 - range * frac, zl2 = lower2 - range * (frac + 1 / p.gradientSteps * p.gradientSize);
      ctx.fillStyle = '#0ecb81';
      ctx.fillRect(s.ca.x, p2y(zl1, s), s.ca.width, Math.max(1, p2y(zl2, s) - p2y(zl1, s)));
      ctx.restore();
    }
  }

  // Draw bands as lines across visible range
  function drawBandLine(price, color, lw, dashed) {
    const y = p2y(price, s);
    if (y < s.ca.y || y > s.ca.y + s.ca.height) return;
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = lw;
    if (dashed) ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(s.ca.x, y); ctx.lineTo(s.ca.x + s.ca.width, y); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
  }
  drawBandLine(upper2, '#f87171', 1.5, false);
  drawBandLine(lower2, '#10b981', 1.5, false);
  drawBandLine(upper1, '#f87171', 1, true);
  drawBandLine(lower1, '#10b981', 1, true);
  drawBandLine(mean,   '#f0b90b', 2, false);

  // Condition label
  const condColor = condition.includes('Over') ? '#f87171' : condition.includes('Under') || condition.includes('Below') ? '#10b981' : '#f0b90b';
  ctx.fillStyle = condColor; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(`MRC: ${condition}`, s.ca.x + 8, s.ca.y + 16);
}

// MRC settings panel (injected into DOM)
function renderMRCSettings() {
  let panel = document.getElementById('mrc-settings-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'mrc-settings-panel';
    panel.style.cssText = `position:absolute;top:50px;left:50%;transform:translateX(-50%);
      background:var(--bg-elevated);border:1px solid var(--border-hi);border-radius:8px;
      padding:14px;z-index:30;min-width:260px;font-size:12px;color:var(--text-hi);
      box-shadow:0 8px 24px rgba(0,0,0,.6)`;
    document.getElementById('chart-body')?.appendChild(panel);
  }
  if (!_mrcSettingsOpen) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const p = _mrcParams;
  panel.innerHTML = `
    <div style="font-weight:600;margin-bottom:10px;display:flex;justify-content:space-between">
      MRC Settings <button onclick="document.getElementById('mrc-settings-panel').style.display='none';window._mrcSettingsOpen=false" style="background:none;border:none;color:var(--text-mid);cursor:pointer;font-size:14px">×</button>
    </div>
    ${[
      ['Period',         'lookbackPeriod',  'number', 10,  500, 1],
      ['Inner mult',     'innerMultiplier', 'number', 0.1, 5,   0.1],
      ['Outer mult',     'outerMultiplier', 'number', 0.5, 10,  0.05],
      ['Zone transp. %', 'zoneTransparency','number', 0,   100, 5],
      ['Gradient size',  'gradientSize',    'number', 0.1, 2,   0.1],
    ].map(([label, key, type, min, max, step]) => `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <label>${label}</label>
        <input type="${type}" value="${p[key]}" min="${min}" max="${max}" step="${step}"
          style="width:80px;background:var(--bg-surface);border:1px solid var(--border);border-radius:4px;color:var(--text-hi);padding:2px 6px"
          onchange="window._mrcChangeParam('${key}', this.value)">
      </div>`).join('')}
    <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
      <label>Show zones</label>
      <input type="checkbox" ${p.displayZone ? 'checked' : ''} onchange="window._mrcChangeParam('displayZone', this.checked)">
    </div>`;
}

window._mrcSettingsOpen = false;
window._mrcChangeParam  = (key, val) => {
  _mrcParams[key] = key === 'displayZone' ? val : parseFloat(val);
  _mrcResult = null;
  window.markDirty?.();
};

// ══════════════════════════════════════════════════════════════════════════════
// §8.5  TRENDLINE SCANNER
// ══════════════════════════════════════════════════════════════════════════════
const TL_PARAMS = {
  pivotRadius: 4, minBarsBetween: 8, minTouches: 3,
  minAngleDeg: 5, maxAngleDeg: 45, touchTolPct: 0.004,
  alertZonePct: 0.006, maxLines: 3, lookback: 300,
};

let _tlLines = null;
let _tlLastLen = 0;

function calculateTrendlines(data) {
  const p   = TL_PARAMS;
  const len = data.length;
  if (len === _tlLastLen && _tlLines) return _tlLines;
  _tlLastLen = len;

  const startIdx = Math.max(0, len - p.lookback);
  const slice    = data.slice(startIdx);
  const { lows, highs } = detectPivots(slice, p.pivotRadius, 0);

  // Convert local indices back to global
  const toLows  = lows.map(pt  => ({ index: pt.index  + startIdx, price: pt.price  }));
  const toHighs = highs.map(pt => ({ index: pt.index + startIdx, price: pt.price }));

  const lastClose = data[len - 1].close;
  const refPrice  = lastClose;

  function buildTL(pivots, subtype) {
    const lines = [];
    for (let i = 0; i < pivots.length; i++) {
      for (let j = i + 1; j < pivots.length; j++) {
        const p1 = pivots[i], p2 = pivots[j]; // p1 older, p2 newer
        if (p1.index >= p2.index) continue;
        const barDist = p2.index - p1.index;
        if (barDist < p.minBarsBetween) continue;

        const slope     = (p2.price - p1.price) / barDist;
        const angleDeg  = Math.atan((slope / refPrice) * 100 * 10) * 180 / Math.PI;
        if (Math.abs(angleDeg) < p.minAngleDeg || Math.abs(angleDeg) > p.maxAngleDeg) continue;
        if (subtype === 'support' && slope > 0) continue;    // support should slope up or flat
        if (subtype === 'resistance' && slope < 0) continue; // resistance slopes down

        const lv = b => p1.price + slope * (b - p1.index);

        // Check not broken between anchors
        let broken = false;
        for (let b = p1.index; b <= p2.index; b++) {
          const lval = lv(b), tol = p1.price * p.touchTolPct;
          if (subtype === 'support'    && data[b].close < lval - tol) { broken = true; break; }
          if (subtype === 'resistance' && data[b].close > lval + tol) { broken = true; break; }
        }
        if (broken) continue;

        // Count touches
        let touches = 2; // anchors count
        for (let b = startIdx; b < len; b++) {
          if (b === p1.index || b === p2.index) continue;
          const extreme = subtype === 'support' ? data[b].low : data[b].high;
          if (Math.abs(extreme - lv(b)) / lv(b) < p.touchTolPct) touches++;
        }
        if (touches < p.minTouches) continue;

        const currentPrice = lv(len - 1);
        const nearAlert    = Math.abs(currentPrice - lastClose) / lastClose < p.alertZonePct;
        lines.push({
          bar1: p1.index, price1: p1.price, bar2: p2.index, price2: p2.price,
          ts1: data[p1.index].openTime, ts2: data[p2.index].openTime,
          subtype, slope, touches, angleDeg: Math.round(angleDeg), currentPrice, nearAlert,
        });
        if (lines.length >= p.maxLines) return lines;
      }
    }
    return lines.slice(0, p.maxLines);
  }

  _tlLines = [
    ...buildTL(toLows,  'support'),
    ...buildTL(toHighs, 'resistance'),
  ];
  return _tlLines;
}

function renderTrendlines(ctx, s, lines) {
  if (!lines || !lines.length) return;
  let suppCount = 0, resCount = 0;
  for (const line of lines) {
    const alert = line.nearAlert;
    const color = alert ? '#f97316' : line.subtype === 'support' ? '#10b981' : '#f87171';
    const lw    = alert ? 2.5 : 1.5;
    _drawRayFromBars(ctx, s, line.bar1, line.price1, line.bar2, line.price2, color, lw,
      line.subtype === 'resistance');

    // Angle + touches label near right edge
    const y    = p2y(line.currentPrice, s);
    const lblY = Math.max(s.ca.y + 12, Math.min(s.ca.y + s.ca.height - 4, y - 4));
    ctx.fillStyle = color; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(`${line.angleDeg}° ${line.touches}✦`, s.ca.x + s.ca.width - 4, lblY);

    if (line.subtype === 'support') suppCount++; else resCount++;
  }
  // Corner counter
  ctx.fillStyle = '#4a5568'; ctx.font = '10px monospace'; ctx.textAlign = 'left';
  ctx.fillText(`TL S:${suppCount} R:${resCount}`, s.ca.x + 4, s.ca.y + 14);
}

// ── Shared helper: draw a ray from bar-indexed anchors ────────────────────────
// Uses ts2xFull-style unclamped math through bar→time mapping
function _drawRayFromBars(ctx, s, bar1, p1, bar2, p2, color, lw = 1.5, dashed = false) {
  // Convert bar indices to visible slot indices
  const x1 = s.ca.x + (bar1 - s.startIndex) * s.xScale + s.xScale * 0.5;
  const x2 = s.ca.x + (bar2 - s.startIndex) * s.xScale + s.xScale * 0.5;
  const y1 = p2y(p1, s), y2 = p2y(p2, s);
  const dx = x2 - x1;
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  if (dashed) ctx.setLineDash([6, 3]);
  ctx.beginPath(); ctx.rect(s.ca.x, s.ca.y, s.ca.width, s.ca.height); ctx.clip();
  if (Math.abs(dx) < 0.001) {
    ctx.moveTo(s.ca.x, y1); ctx.lineTo(s.ca.x + s.ca.width, y1);
  } else {
    const slope = (y2 - y1) / dx;
    const sx = s.ca.x, ex = s.ca.x + s.ca.width;
    ctx.moveTo(sx, y1 + (sx - x1) * slope);
    ctx.lineTo(ex, y1 + (ex - x1) * slope);
  }
  ctx.stroke(); ctx.setLineDash([]); ctx.restore();
}

// Helper: priceToY — delegates to app-scope function
function p2y(price, s) { return s.ca.y + (s.maxP - price) * s.yScale; }

// ── Exports ───────────────────────────────────────────────────────────────────
window.indicators = {
  bounce: {
    label: 'Bounce S/R',
    calculate: calculateBounce,
    render: renderBounce,
    reset: () => { _bounceLinesCache = null; _bounceLastLen = 0; _bounceLastCalcLen = 0; },
  },
  mrc: {
    label: 'Mean Reversion Channel',
    calculate: calculateMRC,
    render: renderMRC,
    reset: () => { _mrcResult = null; },
    openSettings: () => { _mrcSettingsOpen = !_mrcSettingsOpen; renderMRCSettings(); },
  },
  trendline: {
    label: 'Trendline Scanner',
    calculate: calculateTrendlines,
    render: renderTrendlines,
    reset: () => { _tlLines = null; _tlLastLen = 0; },
  },
};
