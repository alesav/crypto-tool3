# Crypto Trading Tool — Astro Rebuild (tool3)

A clean Astro + vanilla-TS rebuild of the crypto trading dashboard.

## Stack
- **Framework**: Astro (static output)
- **Rendering**: Pure Canvas2D (no chart library)
- **Styles**: CSS custom properties, JetBrains Mono
- **Data**: Binance Futures + Bybit Linear REST + WebSocket

## Run locally
```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # produces /dist
npm run preview    # preview the build
```

## Project layout
```
src/
  pages/index.astro      # HTML shell (Astro template)
  styles/global.css      # Full design system
  lib/
    chart-math.ts        # Coordinate transforms, scale, price grid
    chart-renderer.ts    # Canvas drawing engine
    diagonal-sr.ts       # Diagonal S/R indicator
    exchange.ts          # Binance + Bybit API adapters
    alerts-engine.ts     # Alert monitoring + notifications
    risk-calculator.ts   # Risk-based sizing + signing

public/
  scripts/app.js         # Main app bootstrap (browser JS)
  styles/global.css      # Copied for static serving
  favicon.svg
```

## Features implemented
- ✅ Candlestick + volume chart (HiDPI canvas)
- ✅ Real-time kline WebSocket (Binance & Bybit)
- ✅ Pan / zoom / keyboard navigation
- ✅ Manual line drawing (ray + horizontal) with hit testing
- ✅ Diagonal S/R indicator (pivot-pairing algorithm per spec §8.1)
- ✅ Alert system (price + line crossing) with sound notifications
- ✅ Coins screener (Binance / Bybit, sortable, filterable)
- ✅ Scanner (auto-cycling through coins)
- ✅ Trading panel (auth, risk calculator, positions)
- ✅ Persistent state (localStorage: lines, alerts, zoom, last symbol)
- ✅ Mobile-responsive (stacked layout at ≤768px)

## What's left (spec coverage)
- [ ] Bounce S/R, MRC, Trendline Scanner indicators (stubs in dropdown)
- [ ] 12h volume-change metric (IndexedDB cache)
- [ ] Trailing stop engine (§12.7)
- [ ] Actual signed order placement (Binance/Bybit adapters in `exchange.ts`)
- [ ] Service Worker for background alerts when tab hidden
