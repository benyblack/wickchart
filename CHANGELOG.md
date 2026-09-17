# Changelog

## How this project versions

**Semver, from the consumer's perspective.** `wickchart` publishes
`MAJOR.MINOR.PATCH`:

- **PATCH** — bug fixes and correctness changes, no new surface.
- **MINOR** — new features and exports; strictly additive. Attributes,
  methods and events may be *added*; existing ones keep their contract.
- **MAJOR** — breaking changes. The planned 2.0 removes the deprecated
  `hab-*` aliases (`<hab-chart>`, `<hab-feed>`, `hab:*` events — deprecated
  since the rebrand) and moves the big optional features out of the core
  entry (the plugin split, ~9.6 KB reclaim).

**Plugins are independent packages** (`wickchart-draw`, `-sessions`,
`-replay`, `-compare`, `-navigator`, `-alerts-plus`, `-layouts`,
`-signals`, `-tape`, `-grid`, `-paper`) with their own versions; during 0.x
a minor bump may rework their API.

**Releasing:** a release PR (version bump + this file) → merge on green CI
→ annotated tag `vX.Y.Z` → GitHub Release → `npm publish` (the core `prepack`
builds the TypeScript declarations; plugins publish as-is). Size budgets
(`tests/size-budget.test.mjs`) gate every merge — a budget raise is always
its own commit with the why.

---

## 1.7.0 — 2026-09-17

The quant-grade release: information-based bars, million-bar performance
(worker compute + incremental ticks), paper trading on replay, multi-chart
sync, and the branded report export. Every open feature item from the
roadmap's Tracks 1–5 shipped in this version.

### Features

- **Information-based bar aggregation** on `<wick-feed>` —
  `aggregate="tick:200 | volume:50 | dollar:50000"` builds advanced bars
  client-side from the raw trade tape (Binance aggTrade WebSocket +
  paginated REST backfill, offline synthetic prints for `demo=`, JSON
  trades endpoints for `url=`). The pure `TickBarAggregator` is exported
  from `wickchart/feed`. ([#61](https://github.com/benyblack/wickchart/pull/61))
- **`wickchart-grid`** — `<wick-grid cols gap sync>` lays out N charts and
  keeps their visible ranges and crosshairs in step (echo suppression,
  clamp-cycle breaking, ghost crosshair via the layer API). Track 1
  complete. ([#62](https://github.com/benyblack/wickchart/pull/62))
- **`wickchart-paper`** — paper trading on top of `wickchart-replay`:
  orders fill at honest prices (next-bar opens, gap-aware limits), signed
  quantities net and flip, a docked equity curve with peak/drawdown, and
  the position mirrored onto the core positions API with live P&L. The
  engine (`wickchart-paper/core`) doubles as a backtesting library.
  ([#63](https://github.com/benyblack/wickchart/pull/63))
- **Worker compute path** — `import 'wickchart/worker'` +
  `<wick-chart worker>` computes built-in indicators in a Web Worker for
  50k+ bar histories; the dataset crosses once per bulk load as six
  transferable `Float64Array`s. At 1M bars the longest main-thread freeze
  drops from ~270 ms to ~56 ms. New `wickchart/worker` entry.
  ([#64](https://github.com/benyblack/wickchart/pull/64))
- **Incremental indicator updates** — streamed ticks (append /
  forming-bar replace) patch every online-capable series by recomputing a
  bounded tail with the same batch definition: O(warm-up) ≈ 0.1 ms per
  indicator instead of O(full history); worker-computed bases stay fresh
  on the forming bar too. ([#65](https://github.com/benyblack/wickchart/pull/65))
- **Report export** — `wickchart/report`: `exportReport(chart, opts)` /
  `downloadReport()` compose the chart (full DPR), a visible-range stats
  grid and a watermark into one shareable PNG, themed from the chart's own
  CSS variables. `reportModel()` is exported as plain data.
  ([#66](https://github.com/benyblack/wickchart/pull/66))
- **Timezone-aware axes + VWAP session anchor** — `timezone=` and
  `vwap-anchor=` attributes, DST-correct. ([#58](https://github.com/benyblack/wickchart/pull/58))
- **Plugins hub** — plugins.html with per-plugin docs and live playgrounds
  (now 11 packages), plus the **tape** plugin (time & sales with tick-rule
  side inference and trades→bars). ([#53](https://github.com/benyblack/wickchart/pull/53),
  [#50](https://github.com/benyblack/wickchart/pull/50))
- Closed-candle alert evaluation (`evaluate="close"` for price and
  WickScript alerts). ([#56](https://github.com/benyblack/wickchart/pull/56))

### Performance & correctness

- One bar per timestamp in `setData`, binary-search out-of-order inserts,
  backfill that doesn't refire alerts. ([#57](https://github.com/benyblack/wickchart/pull/57))
- Real-time correctness hardening: repeating alerts, alert evaluation
  order, seconds-vs-milliseconds timestamps, React data/timestamps.
  ([#56](https://github.com/benyblack/wickchart/pull/56))
- Percent return ignores position size; hh/ll windows go linear.
  ([#56](https://github.com/benyblack/wickchart/pull/56))
- Main-entry gzip budget 72 → 74 KB (raised in its own commit for the
  worker chokepoint; entry lands at 73.89 KB).

### Fixes

- Mobile/touch: scroll handoff, long-press scrub, overlay collisions,
  phone-fitting pages. ([#60](https://github.com/benyblack/wickchart/pull/60),
  [#52](https://github.com/benyblack/wickchart/pull/52))
- Plugins-hub Level tool wired to the draw plugin's `hline` tool name.
  ([#55](https://github.com/benyblack/wickchart/pull/55))
- Pages deploy guard strips `#fragments` before resolving local
  references. ([#54](https://github.com/benyblack/wickchart/pull/54))

### Testing & site

- **Playwright suite** for the browser-only layer (mount, data, inter-
  action, mobile, responsive, timezone, pages, visual-opt-in) plus
  worker/report specs; 549 unit + 81 e2e tests green on this release.
  ([#59](https://github.com/benyblack/wickchart/pull/59))
- Demos: the zero-JS declarative page gains an aggregated-bars chart;
  `demo/worker.html` loads 1M bars in worker/sync modes with live freeze
  numbers; docs.html documents the new entries end to end.

### Publishing notes

- `wickchart@1.7.0` plus the new plugin packages **`wickchart-grid`** and
  **`wickchart-paper`** (first releases, 0.1.0) need `npm publish`.
- New core exports: `./worker`, `./report`.

## 1.6.0 — 2026-09-10

The plugin family: `wickchart-sessions`, `-replay`, `-compare`,
`-navigator`, `-alerts-plus`, `-layouts`, `-signals` (each an opt-in
package with its own gzip budget), the core `insetBottom` dock hook, and
the indicator breadth wave (OHLC bars, hollow, Heikin-Ashi, step lines,
VWAP/ATR/Stoch/OBV/Donchian/Keltner/CCI/WR/SuperTrend).

(Earlier history: see `git log` — releases predate this file.)
