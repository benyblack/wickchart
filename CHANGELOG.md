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
`-signals`, `-tape`, `-grid`, `-paper`, `-animate`) with their own versions;
during 0.x a minor bump may rework their API.

**Releasing:** a release PR (version bump + this file) → merge on green CI
→ annotated tag `vX.Y.Z` → GitHub Release → `npm publish` (the core `prepack`
builds the TypeScript declarations; plugins publish as-is). Size budgets
(`tests/size-budget.test.mjs`) gate every merge — a budget raise is always
its own commit with the why.

---

## 2.3.0 — 2026-09-21 — named themes & animate

Two shipped features. npm goes 2.2.0 → 2.3.0 (minor: new additive surface —
the `registerTheme()` core export), and `wickchart-animate` joins the
plugin family. The main entry landed at ~67.2 KB gz; the ceiling was raised 67→68 KB (its own
commit) for the theme-seeded shadow chrome.

- **`registerTheme()` — named custom themes (core export from
  `'wickchart'` / `'wickchart/core'`).** A partial palette merged over
  `{ base: 'dark' | 'light' }` (default dark) and stored in the theme
  registry itself, so every lookup resolves it: the `theme` attribute
  accepts any registered name, the PNG report export follows the chart's
  registered theme, and saved layouts / shareable presets round-trip the
  name. `--wick-*` CSS variables still override the registry slot by slot.
  Unknown palette keys drop; a string `overlay` expands and an array pads;
  `volAlpha` coerces; re-registering overwrites live, built-in names
  included.
- **The `wickchart-animate` opt-in plugin** — live-price easing (2.3 KB
  gz, its own 4 KB CI budget): ticks on the forming bar glide to their
  new close. `attachAnimate(chart, { duration, easing, volume })` with
  `.detach()`; the final frame always writes the true bar, new bars flush
  the previous bar's true value, backfills pass through un-eased, and
  `prefers-reduced-motion` is a hard passthrough. Peer dependency:
  wickchart ≥ 2.3.

## 2.2.0 — 2026-09-21 — ichimoku

One batch: the cloud (#82). npm goes 2.1.0 → 2.2.0 (minor: new additive
surface — the `ichimoku` built-in and the `fill` channel on indicator
compute results). wickchart-ai 0.1.1 (description token refresh only —
its `set_indicators` validation is registry-driven at runtime, so 0.1.0
already works against this core). Main-entry budget 66 → 67 KB gz, the
raise in its own commit with the why.

- **The `ichimoku` overlay.** Tenkan/kijun midpoints over their
  high/low windows, the two senkou spans displaced `disp` bars into the
  future, chikou (close) displaced the same distance back. Defaults
  9/26/52/26, positional token `ichimoku:7/22/44/22`. The senkou arrays
  run `disp` bars past the last bar and the renderer projects them into
  the right margin — the same +1 slack the view gives data, so the
  default margin shows the leading edge and scrolling right reveals the
  full cloud.
- **The kumo, two-tone.** Indicator compute results can now return
  `fill: {a, b}`; `normalizeIndicatorResult` validates and passes it
  through (JSDoc-typed in the public surface, and the worker compute
  path inherits it for free). The overlay renderer paints it as
  run-batched translucent polygons — palette `up` where `a ≥ b`, `down`
  otherwise, null gaps split runs — the vol-regime flushing pattern
  applied between two series.
- **Streaming:** ichimoku joins `ONLINE_SKIP` — forward-displaced
  arrays can't align with the tail patcher, so live ticks take the full
  recompute (the supertrend behavior).

## 2.1.0 — 2026-09-21 — the polish track

The roadmap's remaining open items, delivered as one batch (#80, per-step
commits; every judgment call recorded in
`docs/decisions/2.1.0-polish-track.md`):

- **Live-render polish.** The **y-range settles** — the vertical twin of
  2.0.2's axis-width fix: a tick that sets a new visible extreme expands
  the scale at once, contraction waits for a sustained 750ms hold under
  90% usage, and user window changes snap to a fresh fit. No more
  vertical breathing on high-frequency feeds. The **crosshair moved to
  an offscreen hover layer** — a pointer crossing the chart repaints only
  that transparent canvas, never the series beneath (0 full renders
  across 20 hover calls, browser-measured and e2e-pinned).
- **Close-extreme downsampling for line/area charts at deep zoom** —
  pixel columns already kept high/low extremes for candles; they now
  also track close min/max, both joining the polyline, so a one-bar
  spike inside a column survives (and drives the autoscale).
- **Cross-symbol spread panes**: `chart.setSeries(name, bars)` registers
  a second symbol; WickScript reads it as `name_close`/`name_high`/…
  (time-aligned, NaN in gaps). `pexpr:{close - eth_close}` is a spread
  pane with its own autoscaled axis.
- **i18n string packs + `preset`**: built-in chrome (empty state, stats
  chip, measure readout, aria label) reads from language packs — `lang`
  with `en`/`de` built in, hosts register their own via
  `WickChart.registerStrings()`. `preset="minimal|pro"` is a chrome
  starting point that explicit attributes always override.
- **Deferred (documented): the columnar typed-array main-thread store** —
  measured, not needed (render is O(pixel columns) and flat in store
  size; the scan it optimizes costs 10.5 ms/M bars at full zoom only;
  the worker path already computes columnar). Reopen trigger in the
  decision log.

## 2.0.2 — 2026-09-18

The axis settles. **npm goes 2.0.0 → 2.0.2**: the 2.0.1 transparent-theme
fix below was versioned on `main` but never tagged or published, so this
release carries it to the registry for the first time alongside the fix
below.

- **Fix — the live chart no longer shakes on high-frequency feeds.** The
  price-axis width was re-measured from the formatted *last close* every
  render, and digits in a proportional font measure differently ("1" is
  narrower than "8"), so each tick flipped the `ceil()` a pixel at a time.
  Since every candle anchors at `plotRight = W − priceW`, the axis separator
  and the whole candle field slid a pixel sideways per tick — visibly
  shaking on pairs that tick many times a second. The width now grows
  immediately (a wider label must never clip), ignores sub-2px
  digit-width noise, and adopts a genuinely narrower width only after it
  has held for 750ms; `setData`/`clearData` re-measure from scratch so a
  symbol switch snaps to its own axis.

## 2.0.1 — 2026-09-18

A one-line correctness fix for transparent themes. `_render()` cleared the
canvas by filling it with the theme background — the only clear — so a
`--wick-bg: transparent` chart never cleared at all: every redraw (toggle,
pan, streamed tick, crosshair move) stacked on the previous frame's pixels,
accumulating into ghost candles and smeared axis labels. First observed in
the wild on tick.market's coin pages after they themed the chart with a
transparent background over a card. `_render()` now `clearRect()`s before
painting the background, which makes `--wick-bg: transparent` a fully
supported theme; opaque backgrounds are unaffected (clear + fill repaints
exactly what the fill painted before).

- `e2e/transparent-bg.spec.mjs` pins the contract on a real canvas: pixels
  inked by one frame must not survive a redraw (fails on 2.0.0, passes here).

## 1.7.1 — 2026-09-17

A deprecation release on the road to 2.0: every 0.x `hab-*` alias now warns
— once per surface, naming its replacement — so 2.0 fails loudly with a
readable message instead of mysteriously breaking at the major. The aliases
themselves are unchanged until the cut.

- `<hab-chart>` / `<hab-feed>` warn on creation → use the `wick-*` elements.
- `hab:*` / `hab-feed:*` events warn on first dispatch (they keep firing)
  → listen for `wick:*` / `wick-feed:*`.
- A `--hab-*` CSS variable actually consumed by the runtime theme warns →
  rename to `--wick-*`. (The static stylesheet fallbacks are pure CSS and
  cannot warn; the full list lives in the README migration section.)

The 2.0 plugin-split packages are published side by side on the plugins hub
(`wickchart-narrator`, `-coview`, `-scenario`, `-ai`), and the docs and demo
already treat them as the canonical home of the moved features — the draft
2.0.0 notes below spell out the migration.

## 2.0.0 — 2026-09-17

Breaking changes per the plan ([ROADMAP-V2.md]). Draft notes; finalized at
release.

**Removed — the 0.x `hab-*` aliases** (deprecated since the 1.0 rebrand,
warning since 1.7.1): the `<hab-chart>` / `<hab-feed>` elements, the
`hab:*` and `hab-feed:*` event aliases (events fire once, as `wick:*` /
`wick-feed:*`), and the `--hab-*` CSS-variable fallbacks (stylesheet and
runtime — `--wick-*` only).

**Moved to plugins — the six optional feature families** (~9.6 KB leaves
the core entry, back under ~65 KB gz). Each `attachX(chart)` installs the
familiar methods on the instance, so call sites keep their shape with one
added import; without the package the methods become warn-once stubs
naming it:

| 1.x (in core) | 2.0 package |
|---|---|
| `narrate()` `walk()` `stopWalk()` `playRange()` `captureScene()` `getStory()` `playStory()` `stopStory()`, the `sonify` attribute | `wickchart-narrator` |
| `co-view` / `co-view-name` attributes, `getPeers()` | `wickchart-coview` |
| `setScenario()` / `clearScenario()` / `setRiskPlan()` / `clearRiskPlan()` | `wickchart-scenario` |
| `aiTools()` `aiPrompt()` `aiContext()` `applyAI()` `ask()` | `wickchart-ai` |

**Stays in core:** `getDataWindow()` — a data API, not an LLM API (the
packages compose it). `getState()` / `setState()` are unaffected (none of
the moved features serialize through them).

**Migration guide:** README → "Migrating from 1.x to 2.x".

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
