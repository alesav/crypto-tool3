/**
 * store.ts
 * Client-side state persistence helpers (localStorage + IndexedDB).
 */

const PREFIX = 'cryptoTool_';

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(PREFIX + key);
    if (v === null) return fallback;
    return JSON.parse(v) as T;
  } catch { return fallback; }
}

export function lsSet<T>(key: string, value: T): void {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch {}
}

export function lsRemove(key: string): void {
  try { localStorage.removeItem(PREFIX + key); } catch {}
}

// ── IndexedDB for 12h volume change cache ─────────────────
const IDB_NAME = 'cryptoTool';
const IDB_STORE = 'volumeChanges';
const TWELVE_HOURS = 12 * 60 * 60 * 1000;

let _db: IDBDatabase | null = null;

async function getDb(): Promise<IDBDatabase> {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => { _db = req.result; resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
}

interface VolumeEntry {
  id: string;
  value: number;
  timestamp: number;
}

export async function vcGet(symbol: string, interval: string): Promise<number | null> {
  try {
    const db = await getDb();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(`${symbol}_${interval}`);
      req.onsuccess = () => {
        const entry: VolumeEntry | undefined = req.result;
        if (!entry || Date.now() - entry.timestamp > TWELVE_HOURS) { resolve(null); return; }
        resolve(entry.value);
      };
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

export async function vcSet(symbol: string, interval: string, value: number): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ id: `${symbol}_${interval}`, value, timestamp: Date.now() });
  } catch {}
}

// ── Alert persistence ─────────────────────────────────────
export interface Alert {
  id: string;
  symbol: string;
  type: 'above' | 'below' | 'cross-above' | 'cross-below' | 'cross-any';
  targetPrice: number;
  line?: {
    price1: number; ts1: number;
    price2: number; ts2: number;
    subtype?: string;
  };
  isActive: boolean;
  isTriggered: boolean;
  frequency: 'once' | 'continuous';
  note?: string;
  createdAt: number;
  triggeredAt?: number;
  triggerPrice?: number;
  lastCheckedState?: 'above' | 'below';
  lastCheckedPrice?: number;
}

const ALERTS_KEY = 'alerts_v2';
const HISTORY_KEY = 'alertsHistory_v1';
const MAX_ALERTS = 100;
const MAX_HISTORY = 25;

export function loadAlerts(): Alert[] {
  return lsGet<Alert[]>(ALERTS_KEY, []);
}

export function saveAlerts(alerts: Alert[]): void {
  lsSet(ALERTS_KEY, alerts.slice(0, MAX_ALERTS));
}

export function loadAlertHistory(): Alert[] {
  return lsGet<Alert[]>(HISTORY_KEY, []);
}

export function saveAlertHistory(history: Alert[]): void {
  lsSet(HISTORY_KEY, history.slice(0, MAX_HISTORY));
}

// ── Manual lines ──────────────────────────────────────────
export interface ManualLine {
  id: string;
  price1: number; ts1: number;
  price2: number; ts2: number;
  isHorizontal: boolean;
}

export function loadLines(symbol: string): ManualLine[] {
  return lsGet<ManualLine[]>(`lines_${symbol}`, []);
}

export function saveLines(symbol: string, lines: ManualLine[]): void {
  lsSet(`lines_${symbol}`, lines);
}

// ── Misc preferences ──────────────────────────────────────
export function loadZoom(): number {
  return lsGet<number>('zoomLevel', 120);
}
export function saveZoom(v: number): void { lsSet('zoomLevel', v); }

export function loadLastSymbol(): { symbol: string; exchange: string } {
  return lsGet('lastSymbol', { symbol: 'BTCUSDT', exchange: 'binance' });
}
export function saveLastSymbol(symbol: string, exchange: string): void {
  lsSet('lastSymbol', { symbol, exchange });
}

export function loadFilters() {
  return lsGet('coinFilters', { exchange: 'binance', minVolume: 20, symbol: '', sortCol: 'priceChangePercent', sortDir: 'desc' });
}
export function saveFilters(f: object): void { lsSet('coinFilters', f); }

export function loadCredentials(): { apiKey: string; apiSecret: string; exchange: string } | null {
  return lsGet<any>('tradingCredentials', null);
}
export function saveCredentials(creds: { apiKey: string; apiSecret: string; exchange: string }): void {
  lsSet('tradingCredentials', creds);
}
