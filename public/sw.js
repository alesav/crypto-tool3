/**
 * sw.js — Service Worker for background price alerts + app shell caching
 * Per CLONE_SPECIFICATION §11.5
 *
 * Code review fixes:
 * - Cache-then-network (stale-while-revalidate) for JS scripts: serves cached
 *   version immediately but revalidates in background so deploys propagate.
 * - SHELL_ASSETS derived from the URL pattern, not a hardcoded list, so new
 *   scripts are cached automatically on first fetch.
 * - push handler: uses event.data.json() correctly (PushMessageData method)
 */

const CACHE_VERSION = 'crypto-tool-v2';
// Shell assets explicitly listed for install-time precaching.
// If you add a new script, bump CACHE_VERSION to force re-install.
const PRECACHE_ASSETS = [
  '/',
  '/styles/global.css',
  '/scripts/app.js',
  '/scripts/indicators.js',
  '/scripts/trading.js',
  '/favicon.svg',
];

// ── Install: precache shell ───────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => {
        // Don't fail install if a precache asset 404s (e.g. during dev)
        console.warn('[SW] Precache partial failure:', err);
      })
  );
});

// ── Activate: purge old cache versions ───────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: stale-while-revalidate for same-origin assets ─────────────────────
// Scripts (.js, .css) use stale-while-revalidate so deploys propagate in the
// background without blocking the user. HTML uses network-first so the user
// always gets the freshest page shell.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests; pass exchange API calls straight through
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  const isScript = url.pathname.endsWith('.js') || url.pathname.endsWith('.css');
  const isHtml   = url.pathname === '/' || url.pathname.endsWith('.html');

  if (isHtml) {
    // Network-first for HTML: user always gets latest page structure
    event.respondWith(
      fetch(event.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  if (isScript) {
    // Stale-while-revalidate for scripts/styles: serve cache immediately,
    // update cache in background so next load gets new version
    event.respondWith(
      caches.open(CACHE_VERSION).then(async cache => {
        const cached = await cache.match(event.request);
        const fetchPromise = fetch(event.request).then(res => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        }).catch(() => null);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Default: cache-first for other assets (fonts, images)
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// ── Message handler — receive alert events from main thread ───────────────────
self.addEventListener('message', async event => {
  const { type, payload } = event.data || {};

  if (type === 'ALERT_FIRE') {
    const { symbol, alertType, price, targetPrice, id } = payload;
    const sym  = symbol.replace('USDT', '/USDT');
    const dir  = {
      'above': '▲ ABOVE', 'below': '▼ BELOW',
      'cross-any': '↕ CROSSED', 'cross-above': '▲ CROSSED UP', 'cross-below': '▼ CROSSED DOWN',
    }[alertType] || alertType.toUpperCase();

    const title = `🚨 ${sym} — Price Alert`;
    const body  = `${dir} ${formatPrice(targetPrice)}\nCurrent price: ${formatPrice(price)}`;

    await self.registration.showNotification(title, {
      body,
      icon:    '/favicon.svg',
      badge:   '/favicon.svg',
      tag:     `alert-${id}`,
      renotify: true,
      requireInteraction: true,   // stays on screen until dismissed (Android + desktop)
      silent:  false,             // use system notification sound
      vibrate: [300, 100, 300, 100, 600],  // long-short-long vibration on Android
      data:    { symbol, url: `/?symbol=${symbol}` },
      actions: [
        { action: 'view',    title: '📊 Open chart' },
        { action: 'dismiss', title: 'Dismiss'       },
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

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin));
      if (existing) {
        existing.focus();
        existing.postMessage({ type: 'FOCUS_SYMBOL', payload: { symbol } });
      } else {
        self.clients.openWindow(url || '/').then(win => {
          win?.postMessage({ type: 'FOCUS_SYMBOL', payload: { symbol } });
        });
      }
    })
  );
});

// ── Push (reserved for future server-push alerts) ─────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  // FIX: event.data is PushMessageData — use .json() method (not optional chaining .json?.())
  let data;
  try { data = event.data.json(); } catch { return; }

  if (data?.type === 'ALERT_FIRE') {
    event.waitUntil(
      self.registration.showNotification('🚨 Crypto Alert', {
        body: data.body || 'Price alert triggered',
        icon: '/favicon.svg',
        data,
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
