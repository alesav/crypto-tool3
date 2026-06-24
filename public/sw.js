/**
 * sw.js — Service Worker for background price alerts
 * Per CLONE_SPECIFICATION §11.5
 *
 * Responsibilities:
 * - Cache app shell for offline use
 * - Receive ALERT_FIRE messages from the main thread
 * - Show persistent desktop notifications with action buttons
 * - Handle notification clicks to focus the correct symbol
 */

const CACHE_VERSION = 'crypto-tool-v1';
const SHELL_ASSETS  = ['/', '/styles/global.css', '/scripts/app.js', '/scripts/indicators.js', '/scripts/trading.js', '/favicon.svg'];

// ── Install: cache app shell ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

// ── Activate: purge old caches ────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: serve from cache first for shell assets ────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Only cache same-origin requests; pass exchange API calls through
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(event.request, clone));
      }
      return res;
    }))
  );
});

// ── Message handler — receive alert events from main thread ───────────────────
self.addEventListener('message', async event => {
  const { type, payload } = event.data || {};

  if (type === 'ALERT_FIRE') {
    const { symbol, alertType, price, targetPrice, id } = payload;
    const body = `${symbol.replace('USDT', '/USDT')} ${alertType} ${formatPrice(targetPrice)} — triggered at ${formatPrice(price)}`;
    await self.registration.showNotification('🚨 Crypto Alert', {
      body,
      icon:    '/favicon.svg',
      badge:   '/favicon.svg',
      tag:     `alert-${id}`,
      renotify: true,
      requireInteraction: true,
      data:    { symbol, url: `/?symbol=${symbol}` },
      actions: [
        { action: 'view',    title: 'View chart' },
        { action: 'dismiss', title: 'Dismiss'    },
      ],
    });
  }

  if (type === 'PING') {
    event.ports?.[0]?.postMessage({ type: 'PONG' });
  }
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { symbol, url } = event.notification.data || {};

  if (event.action === 'dismiss') return;

  // Focus or open the app tab, then postMessage to load the symbol
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin));
      if (existing) {
        existing.focus();
        existing.postMessage({ type: 'FOCUS_SYMBOL', payload: { symbol } });
      } else {
        self.clients.openWindow(url || '/').then(win => {
          if (win) win.postMessage({ type: 'FOCUS_SYMBOL', payload: { symbol } });
        });
      }
    })
  );
});

// ── Push (future) ─────────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  // Reserved for future server-push alerts
  const data = event.data?.json?.() || {};
  if (data.type === 'ALERT_FIRE') {
    event.waitUntil(
      self.registration.showNotification('🚨 Crypto Alert', {
        body: data.body || 'Price alert triggered',
        icon: '/favicon.svg', data: data,
      })
    );
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatPrice(p) {
  if (!p) return '—';
  if (p < 0.01)  return p.toFixed(8);
  if (p < 1)     return p.toFixed(4);
  if (p < 100)   return p.toFixed(3);
  if (p < 1000)  return p.toFixed(2);
  return p.toLocaleString('en', { maximumFractionDigits: 0 });
}
