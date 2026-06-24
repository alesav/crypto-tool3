/**
 * diagonal-sr.ts
 * Diagonal Support/Resistance indicator — Pine-Script-style pivot pairing.
 * Per CLONE_SPECIFICATION §8.1
 */

import type { Candle } from './chart-math';
import type { DiagLine } from './chart-renderer';

const PARAMS = {
  historyBarsBack: 150,
  halfResolution: 4,
  maxSupportLines: 5,
  maxResistanceLines: 5,
  minLineLength: 20,
};

interface Pivot { index: number; price: number; }

function detectPivots(data: Candle[], startIdx: number): { lows: Pivot[]; highs: Pivot[] } {
  const hr = PARAMS.halfResolution;
  const lows: Pivot[] = [];
  const highs: Pivot[] = [];
  const end = data.length - hr;

  for (let i = Math.max(hr, startIdx); i < end; i++) {
    const low = data[i].low;
    const high = data[i].high;
    let isLow = true, isHigh = true;
    for (let j = i - hr; j <= i + hr; j++) {
      if (j === i) continue;
      if (data[j].low <= low) isLow = false;
      if (data[j].high >= high) isHigh = false;
    }
    if (isLow)  lows.push({ index: i, price: low });
    if (isHigh) highs.push({ index: i, price: high });
  }
  return { lows, highs };
}

function priceAt(bar1: number, price1: number, bar2: number, price2: number, target: number): number {
  if (bar2 === bar1) return price1;
  return price1 + (price2 - price1) * (target - bar1) / (bar2 - bar1);
}

function isIntersected(
  data: Candle[],
  startBar: number, endBar: number,
  bar1: number, price1: number,
  bar2: number, price2: number,
  type: 'support' | 'resistance'
): boolean {
  for (let i = startBar + 1; i < endBar; i++) {
    const lp = priceAt(bar1, price1, bar2, price2, i);
    const c = data[i];
    if (type === 'support' && Math.min(c.open, c.close) < lp) return true;
    if (type === 'resistance' && Math.max(c.open, c.close) > lp) return true;
  }
  return false;
}

export function calculateDiagonalSR(data: Candle[]): DiagLine[] {
  if (data.length < PARAMS.halfResolution * 2 + 1) return [];

  const startIdx = Math.max(0, data.length - PARAMS.historyBarsBack);
  const { lows, highs } = detectPivots(data, startIdx);
  const currentBar = data.length - 1;
  const currentHigh = data[currentBar].high;
  const currentLow = data[currentBar].low;

  const results: DiagLine[] = [];

  // Support lines (through pivot lows)
  const sortedLows = [...lows].sort((a, b) => b.index - a.index);
  const supportLines: DiagLine[] = [];

  for (let i = 0; i < Math.min(sortedLows.length, 50); i++) {
    const p1 = sortedLows[i];
    for (let j = i + 1; j < Math.min(sortedLows.length, i + 50); j++) {
      const p2 = sortedLows[j];
      if (p1.index - p2.index < PARAMS.minLineLength) continue;
      if (p1.index > p2.index * 8) break;

      if (isIntersected(data, p2.index, p1.index, p2.index, p2.price, p1.index, p1.price, 'support')) continue;

      const currentLevel = priceAt(p2.index, p2.price, p1.index, p1.price, currentBar);
      if (currentLevel >= currentHigh) continue;

      const line: DiagLine = {
        ts1: data[p2.index].openTime,
        price1: p2.price,
        ts2: data[p1.index].openTime,
        price2: p1.price,
        type: 'support',
        currentPrice: currentLevel,
      };

      // Replacement rule: if shares pivot1 with last line, keep higher currentLevel
      const last = supportLines[supportLines.length - 1];
      if (last && last.ts2 === line.ts2) {
        if (currentLevel > last.currentPrice) supportLines[supportLines.length - 1] = line;
      } else {
        supportLines.push(line);
      }

      if (supportLines.length >= PARAMS.maxSupportLines) break;
    }
    if (supportLines.length >= PARAMS.maxSupportLines) break;
  }

  // Resistance lines (through pivot highs)
  const sortedHighs = [...highs].sort((a, b) => b.index - a.index);
  const resistanceLines: DiagLine[] = [];

  for (let i = 0; i < Math.min(sortedHighs.length, 50); i++) {
    const p1 = sortedHighs[i];
    for (let j = i + 1; j < Math.min(sortedHighs.length, i + 50); j++) {
      const p2 = sortedHighs[j];
      if (p1.index - p2.index < PARAMS.minLineLength) continue;
      if (p1.index > p2.index * 8) break;

      if (isIntersected(data, p2.index, p1.index, p2.index, p2.price, p1.index, p1.price, 'resistance')) continue;

      const currentLevel = priceAt(p2.index, p2.price, p1.index, p1.price, currentBar);
      if (currentLevel <= currentLow) continue;

      const line: DiagLine = {
        ts1: data[p2.index].openTime,
        price1: p2.price,
        ts2: data[p1.index].openTime,
        price2: p1.price,
        type: 'resistance',
        currentPrice: currentLevel,
      };

      const last = resistanceLines[resistanceLines.length - 1];
      if (last && last.ts2 === line.ts2) {
        if (currentLevel < last.currentPrice) resistanceLines[resistanceLines.length - 1] = line;
      } else {
        resistanceLines.push(line);
      }

      if (resistanceLines.length >= PARAMS.maxResistanceLines) break;
    }
    if (resistanceLines.length >= PARAMS.maxResistanceLines) break;
  }

  return [...supportLines, ...resistanceLines];
}
