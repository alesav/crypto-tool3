/**
 * alerts-engine.ts
 * Background alert monitoring: mini-ticker WebSocket + polling fallback.
 * Triggers sound + desktop notifications.
 */

import type { Alert } from './store';
import { crossingPrice } from './chart-math';
import { loadAlerts, saveAlerts, loadAlertHistory, saveAlertHistory } from './store';

type PriceMap = Map<string, number>;

// ── Sound ─────────────────────────────────────────────────
function playAlertSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  } catch {}
}

// ── Notification ──────────────────────────────────────────
function showNotification(title: string, body: string, symbol: string) {
  if (Notification.permission === 'granted') {
    try {
      new Notification(title, { body, icon: '/favicon.svg' });
    } catch {}
  }
}

export async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

// ── Dynamic crossing price for line alerts ────────────────
function dynamicCrossingPrice(alert: Alert, prices: PriceMap): number | null {
  if (!alert.line) return alert.targetPrice;
  const { price1, ts1, price2, ts2 } = alert.line;
  return crossingPrice(price1, ts1, price2, ts2, Date.now());
}

// ── Trigger check ─────────────────────────────────────────
function checkAlert(alert: Alert, price: number): boolean {
  if (!alert.isActive || alert.isTriggered) return false;

  if (alert.line) {
    const crossing = dynamicCrossingPrice(alert, new Map());
    if (crossing === null) return false;
    const state = price > crossing ? 'above' : 'below';
    if (!alert.lastCheckedState) {
      alert.lastCheckedState = state;
      return false;
    }
    if (state === alert.lastCheckedState) return false;
    alert.lastCheckedState = state;
    if (alert.type === 'cross-any') return true;
    if (alert.type === 'cross-above' && state === 'above') return true;
    if (alert.type === 'cross-below' && state === 'below') return true;
    return false;
  }

  if (alert.type === 'above') return price >= alert.targetPrice;
  if (alert.type === 'below') return price <= alert.targetPrice;
  return false;
}

// ── Main engine class ─────────────────────────────────────
export class AlertsEngine {
  private priceMap: PriceMap = new Map();
  private wsCleanup: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private wsConnected = false;
  private lastWsData = 0;
  onAlertFired?: (alert: Alert) => void;

  start() {
    this._connectWS();
    this.pollTimer = setInterval(() => this._pollFallback(), 2000);
    requestNotificationPermission();
  }

  stop() {
    this.wsCleanup?.();
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  updatePrice(symbol: string, price: number) {
    this.priceMap.set(symbol, price);
    this._checkSymbol(symbol, price);
  }

  private _connectWS() {
    let attempts = 0;
    const connect = () => {
      const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
      ws.onmessage = (ev) => {
        this.lastWsData = Date.now();
        this.wsConnected = true;
        const data: any[] = JSON.parse(ev.data);
        for (const t of data) {
          const price = parseFloat(t.c);
          this.priceMap.set(t.s, price);
          this._checkSymbol(t.s, price);
        }
      };
      ws.onclose = () => {
        this.wsConnected = false;
        if (attempts < 10) {
          const delay = Math.min(5000 * Math.pow(1.5, attempts), 30000);
          setTimeout(() => { attempts++; connect(); }, delay);
        }
      };
      ws.onopen = () => { attempts = 0; };
      this.wsCleanup = () => ws.close();
    };
    connect();
  }

  private async _pollFallback() {
    const stale = !this.wsConnected || (Date.now() - this.lastWsData > 30000);
    if (!stale) return;
    const alerts = loadAlerts().filter(a => a.isActive);
    if (!alerts.length) return;

    const symbols = [...new Set(alerts.map(a => a.symbol))];
    try {
      const symbolsParam = JSON.stringify(symbols.slice(0, 20));
      const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbols=${encodeURIComponent(symbolsParam)}`);
      const data: any[] = await res.json();
      for (const t of data) {
        const price = parseFloat(t.price);
        this.priceMap.set(t.symbol, price);
        this._checkSymbol(t.symbol, price);
      }
    } catch {}
  }

  private _checkSymbol(symbol: string, price: number) {
    const alerts = loadAlerts();
    let changed = false;

    for (const alert of alerts) {
      if (alert.symbol !== symbol) continue;
      if (!alert.isActive || alert.isTriggered) continue;

      if (checkAlert(alert, price)) {
        alert.isTriggered = true;
        alert.triggeredAt = Date.now();
        alert.triggerPrice = price;
        if (alert.frequency === 'once') alert.isActive = false;
        changed = true;

        playAlertSound();
        showNotification(
          `🚨 Alert: ${alert.symbol}`,
          `Price ${price} ${alert.type} target ${alert.targetPrice.toFixed(4)}`,
          symbol
        );

        const history = loadAlertHistory();
        history.unshift({ ...alert });
        saveAlertHistory(history);

        this.onAlertFired?.(alert);
      }
    }

    if (changed) saveAlerts(alerts);
  }
}

export const alertsEngine = new AlertsEngine();
