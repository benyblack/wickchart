# WickChart Roadmap

North star: **"TradingView-class usefulness inside a zero-dependency custom element."**
Every feature must survive the test: *one tag, zero build step, sane defaults*.

Current state (v1.6): candles/line/area, volume, SMA/EMA/BB overlays, RSI/MACD
panes + custom indicator registry, history backfill, gap dividers, positions
& alerts with live P&L, visible-range stats, measure tool, shareable URL
state, crosshair + OHLC legend, zoom/pan/pinch/keyboard, streaming, theming,
PNG export, ~0.2 ms per frame at default zoom.

**Done (2026-09):** the five recommended PRs below — loadMore backfill + gap
dividers, indicator registry + Bollinger + MACD, positions/orders + alerts,
stats panel + measure tool, getState/setState + URL sharing. Plus a security
hardening pass (strict color validation for untrusted attribute input), the
full indicator breadth (OHLC bars/hollow/Heikin-Ashi, step/baseline lines,
VWAP/ATR/Stoch/OBV/Donchian/Keltner/CCI/WR/SuperTrend), the plugins hub,
Playwright e2e, timezone-aware axes, and tick/volume/dollar bar aggregation
on `<wick-feed>` (PR #61).

Effort: **S** ≤ a day · **M** a few days · **L** a week+. Order within a track
is suggested priority.

---

## Track 1 — Real-world data (make it drop-in for production apps)

| Feature | What & why | Effort | Notes |
|---|---|---|---|
| History backfill (`loadMore`) | `chart.onloadmore = (fromTime) => Promise<bars>` — fetch older bars when the user scrolls past the left edge. Every serious app needs this. | M | Renderer is index-based: shift `rightIndex` by the prepended count to keep the view anchored. |
| Session / gap handling | Optional axis "gap" dividers when bar intervals jump (weekends, market close). | S | x-axis is already index-space, so gaps compress naturally; only axis *labels* need honesty — boundary-based ticks already give most of this. Session shading shipped as the opt-in `wickchart-sessions` plugin instead of a core attr. |
| ~~Second symbol overlay~~ ✅ shipped (plugin) | `wickchart-compare` — percent-rebase compare lines + ratio/diff derived series with a live legend, drawn against an invisible secondary scale. | S | New overlay series type; legend shows both. |
| ~~Range navigator~~ ✅ shipped (plugin) | `wickchart-navigator` — full-dataset silhouette strip with a draggable viewport window; enabled the generic `insetBottom` dock hook in the core layer API. | S | The one plugin that needed a (small) core change. |
| ~~Tick → bar aggregation~~ ✅ shipped | `aggregate="volume\|dollar\|tick"` on `<wick-feed>` — bars close on information, not the clock. Binance aggTrade WS + paginated aggTrades seed/backfill, offline synthetic prints for `demo=`, JSON trades endpoints for `url=`; pure `TickBarAggregator` exported from `wickchart/feed`. | M | Quant-grade feature no mainstream web chart ships built-in. |
| ~~Multi-pane series sync~~ ✅ shipped (plugin) | `wickchart-grid` — `<wick-grid cols gap sync>` lays out N charts and keeps ranges + crosshairs in step (`wick:range`/`wick:crosshair` fan-out with echo suppression + clamp-cycle breaking; ghost crosshair via the layer API; `attachGrid()` for programmatic groups). | S | Track 1 complete. |

## Track 2 — Series & indicators (breadth without bloat)

| Feature | What & why | Effort | Notes |
|---|---|---|---|
| OHLC bars, hollow candles, Heikin-Ashi | Cheap breadth traders expect. | S | Transforms in the candle draw path. |
| Baseline & step-line types | Round out `type=`. | S | |
| Bollinger, VWAP, Donchian, PSAR | Most-requested overlays. | S each | Bollinger = SMA + rolling stdev; VWAP needs session anchor. |
| MACD, Stochastic, OBV, ATR panes | The pane system already stacks N panes (RSI proves it); generalize pane *producers*. | M | MACD = histogram + 2 lines in one pane. |
| **Custom indicator registry** | `HabChart.registerIndicator('myInd', { type:'overlay'\|'pane', compute(bars, params), defaults })` then use `indicators="myInd:14"`. | M | The ecosystem unlock — everything after this is community-extensible. |
| Per-indicator styling | `indicators="sma:20@#f0b429"` syntax + `--wick-*` vars. | S | |
| Indicator settings UX in demo | Chips get a popover (period/color). | S | |

## Track 3 — Trading usefulness (the "more useful than TradingView" layer)

| Feature | What & why | Effort | Notes |
|---|---|---|---|
| **Positions & orders visualization** | `chart.addPosition({ entry, stop, target, qty })` → entry/stop/target zone with live P&L readout against streaming price. TradingView gates this behind Pro. | M | Highest-impact single feature for traders. |
| Price alerts | `addAlert({ price, direction })` → line + `hab:alert` event on cross; optional browser Notification. | S–M | Checked inside `update()`. |
| Measure tool | Shift-drag A→B: Δprice, ±%, Δtime, bar count overlay. | S–M | |
| **Stats panel** | Visible-range analytics: return %, annualized vol, max drawdown, up/down bars, avg volume. | S | Pure functions over visible slice; huge "useful" per line of code. |
| ~~Replay mode~~ ✅ shipped (plugin) | `wickchart-replay` — `replay.start/step/seek/play/pause/stop` + speed & loop; hides the future via the public data API (setData slice + update), badge layer shows the position. ~~Paper trading + equity curve = 0.2 follow-up~~ ✅ shipped as the `wickchart-paper` plugin (next-bar-open market fills, gap-aware limits, netting/flips with averaged entries, fees, docked equity curve with max drawdown, position mirrored onto the core positions API). | S–M | Renderer is data-driven; slice + reuse auto-follow. |
| Candle countdown | Time remaining in the current bar (legend pill). | S | 1 s timer, no re-render cost (HTML overlay). |
| Shareable chart state | `getState()/setState()`; demo maps to URL hash (`#BTC-1h-sma20-rsi`). | S | Stickiness + marketing. |

## Track 4 — Inventions & differentiators (things TradingView doesn't do)

| Idea | What & why | Effort |
|---|---|---|
| ~~**Volume profile**~~ ✅ shipped | Side histogram with POC/VAH/VAL over the visible range. Classic pro tool, rarely free. | M–L |
| ~~**Declarative `<hab-feed>` element**~~ ✅ shipped | `<hab-feed binance="BTCUSDT" tf="1h"></hab-feed><hab-chart>` — a fully live chart with **zero JavaScript written**. The ultimate "modern, simpler" demo. | M |
| ~~**Smart annotations**~~ ✅ shipped | Auto-badge volume spikes, RSI divergences, gaps, N-bar highs/lows; hover for a one-line insight. "Explain mode" for charts. | M |
| ~~Server-side overlays~~ ✅ shipped | `setOverlays()` + JSON attribute for API-computed supply/demand zones & price levels — zones extend into future space like TradingView drawings. | S–M |
| ~~Scenario ghosts + vol cone~~ ✅ shipped | `setScenario({ path, cone })` — hypothetical ghost paths plus ±1σ/±2σ bands widening with √h from realized vol, projected into reserved future space. | M |
| ~~Risk planner (R-multiple grid)~~ ✅ shipped | `setRiskPlan({ entry, stop, multiples \| targets })` — entry/stop define 1R; dashed kR reward lines + shaded risk/reward zones with labeled pills. Position sizing reads straight off the chart. | S–M |
| ~~Co-view presence~~ ✅ shipped | Peer viewports as colored bands + names on the chart, `getPeers()` / `wick:peers`, TTL sweep via `PresenceTracker` — extends the BroadcastChannel co-view protocol without shipping network code. | S–M |
| ~~Bar-walk narrator~~ ✅ shipped | `narrate()` timeline (pivots, spikes, gaps, divergences + derived legs) and `walk()` — a viewport replay with `wick:walk` captions; any user input interrupts. `narrateWindow` in core. | S–M |
| ~~Delta brush~~ ✅ shipped | `<wick-chart brush>` — plain drag selects bars with a live Δ% band + chip; `wick:brush` carries range stats (delta, extremes, Σvol). `brushStats` in core. | S |
| ~~Story mode~~ ✅ shipped | Scenes of chart state (view, type, indicators, overlays, scenario, risk plan) played as a narrated tour with eased camera pans — `captureScene()` / `playStory()` / `wick:story`. Plain-data scenes, shareable. | M |
| ~~Volatility-regime shading~~ ✅ shipped | Background tint by realized-vol percentile — market state at a glance. `<hab-chart volshading="30/70">`, legend shows hovered regime + percentile. | S–M |
| ~~**HabScript mini-language**~~ ✅ shipped | `indicators="expr:{close - sma(close,20)}"` / `pexpr:{…}` — hand-written tokenizer + recursive-descent parser (no `eval`) over builtins, URL-safe, live demo input. | L |
| ~~Cross-tab co-view~~ ✅ shipped | BroadcastChannel syncs crosshair/markings between two open tabs. Great demo flex, tiny code. | S–M |
| ~~Sonification toggle~~ ✅ shipped | Pitch maps to price movement — screen-reader traders get trend by ear. Rare a11y win. | S–M |
| ~~AI-ready data hook~~ ✅ shipped | `chart.getDataWindow()` — structured + markdown summary of the visible window (trend, vol percentile, patterns); demo "Explain" button with copy-to-clipboard. Data stays local. | S |
| Branded snapshot/report export | exportPNG + stats table + watermark composed into one shareable image. | M |
| Spread & ratio charts (pane) | ~~`formula="BTC/ETH"` live derived series~~ derived ratio/diff lines shipped in `wickchart-compare` (rebased, raw value in the legend); a dedicated spread *pane* with its own axis stays open — needs core pane support. | M |

## Track 5 — Engineering & scale (continuous)

- **Tests**: unit tests for pure functions (indicators, ticks, scales), Playwright
  visual-regression diffs, and a **perf-budget CI gate** from the benchmark
  script we already wrote (fail if default-view render > 1 ms). *M*
- **Incremental indicators**: O(1) online updates on stream ticks instead of
  full recompute per version. *S–M*
- **Columnar typed-array store** internally (accept objects, convert once). *M*
- **Min/max downsampling** per pixel column for extreme zoom-outs. *M*
- Offscreen hover layer (crosshair-only repaint). *M*
- Web Worker compute path for 1M+ bars; Rust/WASM only if profiling ever
  demands (see perf analysis — canvas, not JS, is the floor). *M–L*
- Packaging: ~~JSDoc types → `.d.ts`, npm publish + CDN links~~ ✅, ~~`useWickChart`
  React hook + Vue/Svelte examples~~ ✅ shipped as `wickchart/react` (+ live
  `demo/react.html`); semver/changelog policy pending. *S–M*
- i18n for built-in labels; `preset="minimal|pro"` attribute. *S*

### Explicit non-goals

Drawing tools inside the core (they live in the opt-in `wickchart-draw`
plugin — trendline/ray/level/rect/fib/text shipped on the layer API; the
core stays drawing-free), any backend/social layer, an indicator
marketplace (before the registry proves itself), and a WebGL renderer (the
Canvas 2D floor is ~1 ms at our scale — revisit only with profiler evidence).

---

## Recommended next five PRs (value ÷ effort)

1. ~~**`loadMore` backfill + gap dividers**~~ ✅ shipped
2. ~~**Indicator registry + Bollinger + MACD**~~ ✅ shipped
3. ~~**Positions/orders + alerts**~~ ✅ shipped
4. ~~**Stats panel + measure tool**~~ ✅ shipped
5. ~~**`getState()/setState()` + URL sharing**~~ ✅ shipped

**Next up (suggested):** the branded snapshot/report export (Track 4) and
a worker compute path for 1M-bar histories (Track 5) — now more urgent,
since aggregated bars make huge datasets routine. Tracks 1 and 3's replay
follow-up are complete.

Each PR lands with the perf gate green (<1 ms default view, <8 ms max zoom-out).
