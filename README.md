# WickChart

[![npm](https://img.shields.io/npm/v/wickchart)](https://www.npmjs.com/package/wickchart)

**`<wick-chart>` — a modern, simpler, more useful charting web component.**

A TradingView-style financial chart as a single framework-agnostic Web Component.
One file, zero dependencies, one HTML tag. Canvas-rendered, fast, themeable, and
streaming-ready.

<img width="759" height="390" alt="image" src="https://github.com/user-attachments/assets/f335cecc-d5b3-4d27-a982-600b6bc72d6f" />


## Install

```bash
npm install wickchart
```

```js
// any bundler / framework — TypeScript types included
import 'wickchart';                       // registers <wick-chart>
import WickChart from 'wickchart';         // for WickChart.registerIndicator(...)
import { encodeStateQuery } from 'wickchart/core';  // pure helpers
import { WickChart } from 'wickchart/react';        // React bindings (optional)
```

Or straight from a CDN — no install, no build:

```html
<script type="module" src="https://unpkg.com/wickchart"></script>

<wick-chart label="BTC · 1h" type="candles" indicators="sma:20 volume"></wick-chart>

<script type="module">
  const chart = document.querySelector('wick-chart');
  chart.setData(bars);   // [{ time, open, high, low, close, volume }]
  chart.update(bar);     // stream live updates
</script>
```

Works in plain HTML, React, Vue, Svelte, Angular — anywhere a `<div>` works.
TypeScript declarations ship inside the package (generated at pack time from
the JSDoc-annotated source — the repo itself stays 100% dependency-free JS).

## Declarative live charts with `<wick-feed>`

One more script tag and your chart is fully live — data, backfill, streaming —
with **zero JavaScript written**:

```html
<script type="module" src="https://unpkg.com/wickchart/feed"></script>

<wick-feed for="chart" binance="BTCUSDT" tf="1h"></wick-feed>
<wick-chart id="chart" indicators="sma:20 volume" profile></wick-chart>
```

| Attribute   | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `for`       | target `<wick-chart>` id (auto-pairs with the first chart when omitted)   |
| `binance`   | Binance symbol (`BTCUSDT`) — REST load + WebSocket live + backfill       |
| `demo`      | deterministic offline synthetic feed (`demo="ETH"` picks a base price)   |
| `url`       | generic REST endpoint returning a JSON array of bars (+ `poll="10"` sec) |
| `tf`        | timeframe: `1m 3m 5m 15m 30m 1h 2h 4h 6h 12h 1d 3d 1w`                  |
| `limit`     | initial bars (default 500)                                               |
| `live`      | `live="false"` loads history without streaming                           |
| `aggregate` | information-based bars from a trade stream (see below)                   |

The element reflects its state in the `status` attribute (`loading`, `live`,
`polling`, `fallback`, `loaded`, `waiting`, `idle`) and emits
`wick-feed:status` / `wick-feed:fallback` events. When Binance is unreachable
(geo-blocked, offline), it degrades gracefully: WebSocket → REST polling → a
synthetic stream bridged from the last real price, so the chart never goes
blank. It also wires `chart.onloadmore` for infinite backfill automatically.

### Information-based bars (advanced bars)

Add `aggregate` to any feed and bars close on *information*, not the clock:

```html
<wick-feed for="c" binance="BTCUSDT" aggregate="dollar:50000"></wick-feed>
<wick-chart id="c" indicators="volume"></wick-chart>
```

`tick:200` closes a bar every 200 prints, `volume:50` every 50 base units,
`dollar:50000` every $50k traded — the quant-grade alternative to time
candles, built client-side from the raw trade tape (Binance aggTrade
WebSocket + paginated REST backfill; offline synthetic prints with `demo=`;
your own JSON trades endpoint with `url=` + `poll=`). The value you pass *is*
the bar size — tune it per instrument. The machinery is exported too:
`import { TickBarAggregator, aggregateTrades } from 'wickchart/feed'` to pipe
any trade stream through the same aggregator.

---

## Why another chart library?

TradingView's charting library is powerful but heavy and enterprise-licensed;
most wrappers add build steps and framework lock-in. WickChart takes the opposite
bet:

- **Zero dependencies, no build step required** (~67 KB gzipped for the whole
  component — `core.js` + `wick-chart.js`, held to a 68 KB CI budget)
- **One tag, sane defaults** — drop it in and it renders; everything optional
- **Built-in usefulness** — crosshair + OHLC legend, last-price line, wheel zoom,
  drag pan, pinch, keyboard navigation, live streaming, PNG export
- **Themeable with CSS variables** — two built-in themes, full control from
  outside the component (Shadow DOM friendly)
- **Accessible** — focusable, arrow-key crosshair, ARIA summary of the data

## Try it online

The demo site is deployed to GitHub Pages:
**https://benyblack.github.io/wickchart/** — a landing page with a live hero
chart, the full interactive demo, the zero-JavaScript declarative page, and a
[React demo](./demo/react.html) driven entirely by React state.

**Full documentation lives at
[benyblack.github.io/wickchart/docs.html](./docs.html)** — every attribute,
method, event, the WickScript reference, overlays (with a live JSON
playground), feeds, theming and framework bindings, each with runnable
examples. The **[Plugins hub](./plugins.html)** documents every opt-in
package — draw, sessions, replay, compare, navigator, alerts+, layouts,
signals, tape, grid, paper — each with its own live playground. This README covers
the same ground in plain markdown.

## Run the demo locally

```bash
npm run dev        # serves on http://localhost:5173
# or: npx serve . -l 5173
# or: python -m http.server 5173
```

Then open **http://localhost:5173/demo/**.

The demo ships with an offline synthetic feed (random walk with volatility
regimes + live ticking), and optionally loads **real Binance data** (REST +
WebSocket) for BTC/ETH/SOL when the API is reachable from your network —
with graceful fallback to synthetic data if it isn't.

---

## Frameworks

`<wick-chart>` is framework-agnostic — attributes, one `data` property,
standard DOM events. The one opinionated wrapper ships as `wickchart/react`,
which turns that contract into idiomatic React with proper event
subscription/cleanup. `react` is an **optional** peer dependency: nothing
changes if you never import `wickchart/react`.

### React

```bash
npm install wickchart react
```

```jsx
import { WickChart, useWickChart } from 'wickchart/react';

// drop-in component — props map 1:1 onto the element
export function PriceChart({ bars, onRange }) {
  return (
    <WickChart
      type="candles"
      indicators="sma:20 ema:50 volume"
      volshading
      label="BTC · 1h"
      data={bars}                 // bars are assigned as a property
      onRange={onRange}           // subscribes to wick:range
      onAlert={(e) => toast(`crossed ${e.detail.price}`)}
      style={{ height: 420 }}
    />
  );
}

// or the hook, when you need the imperative API
function PracticeChart({ bars }) {
  const { ref, chart } = useWickChart({ data: bars, indicators: 'sma:20' });
  // chart.getDataWindow(), chart.addAlert(...), chart.getState() … after mount
  return <wick-chart ref={ref} style={{ height: 420 }} />;
}
```

Rules of thumb:

- **Pass a fresh array** to `data` when the bars change — the binding compares
  by reference, and reassignment is what triggers a redraw (don't mutate).
  The same rule applies to `overlays` (see
  [Server-side overlays](#server-side-overlays-zones--levels)).
- **String/number/boolean props become attributes** (`type`, `indicators`,
  `volshading`, …); `className`/`style`/`id` reach React as usual.
- **`onXxx` subscribes to `wick:xxx`** with cleanup on unmount; an
  `events={{ range: fn }}` object works too.
- Works the same on React 16.8 → 19 — no custom-element event caveats.

No build step? The [React demo](./demo/react.html) runs straight off a CDN
import map — `react` and `react-dom` from esm.sh, the bindings from the
package source.

### Vue 3

```vue
<script setup>
import { ref, onMounted } from 'vue';
import 'wickchart';
const chart = ref(null);
const bars = ref([]);
onMounted(async () => {
  bars.value = await loadBars();
  chart.value.data = bars.value;
  chart.value.addEventListener('wick:range', (e) => console.log(e.detail));
});
</script>

<template>
  <wick-chart ref="chart" type="candles" indicators="sma:20"
              style="height: 420px"></wick-chart>
</template>
```

### Svelte

```svelte
<script>
  import 'wickchart';
  let el;
  let bars = [];
  $: if (el && bars.length) el.data = bars;
</script>

<wick-chart bind:this={el} type="candles" indicators="sma:20"
            on:wick:alert={(e) => console.log(e.detail)}
            style="height: 420px"></wick-chart>
```

---

## Data format

Bars are plain objects; `time` accepts **milliseconds or seconds** (auto-detected).
For line-style data you can pass `{ time, value }` instead of full OHLCV.

```js
chart.setData([
  { time: 1694000000000, open: 100.5, high: 101.2, low: 99.8, close: 100.9, volume: 1200 },
  // ...
]);
```

## Attributes

| Attribute     | Default    | Description                                                        |
| ------------- | ---------- | ------------------------------------------------------------------ |
| `theme`       | `dark`     | `dark` or `light`                                                   |
| `type`        | `candles`  | `candles`, `line`, `area`, `bars` (OHLC), `hollow` (hollow up-candles), `heikin` (Heikin-Ashi) |
| `indicators`  | `volume`*  | Space/comma-separated: `sma:20`, `ema:50`, `bb:20`, `vwap`, `supertrend:10/3`, `donchian:20`, `keltner:20/2`, `rsi:14`, `macd:12/26/9`, `stoch:14/3`, `atr:14`, `obv`, `cci:20`, `wr:14`, `volume`, or any registered indicator |
| `label`       | –          | Text shown in the legend (e.g. `"BTC · 1h"`)                        |
| `log`         | off        | Logarithmic price scale                                             |
| `auto`        | on         | Keep the right edge pinned to the latest bar while streaming        |
| `precision`   | auto       | Forced decimal places for prices (auto-detected from magnitude)    |
| `stats`       | off        | Live statistics chip for the visible range          |
| `profile`     | off        | Volume profile overlay (POC + 70% value area)       |
| `annotations` | off        | Smart annotations (volume spikes, gaps, pivots, RSI divergences) |
| `volshading`  | off        | Volatility-regime background shading (see below)    |
| `overlays`    | –          | JSON array of server-side zones & levels (see below) |

\* `indicators=""` disables everything, including volume. Token syntax:
`name[:param[/param…]][@color]` — e.g. `sma:20@#ff0000`, `macd:12/26/9`.

### Built-in indicators

| Name | Kind | Params | Notes |
|---|---|---|---|
| `sma` | overlay | `period` (20) | |
| `ema` | overlay | `period` (50) | |
| `bb` | overlay | `period`, `mult` (20, 2) | Bollinger bands (3 lines) |
| `vwap` | overlay | – | hlc3 VWAP, resets each UTC day |
| `supertrend` | overlay | `period`, `mult` (10, 3) | ATR trend line, breaks at flips |
| `donchian` | overlay | `period` (20) | high/low channel + mid |
| `keltner` | overlay | `period`, `mult` (20, 2) | EMA ± mult×ATR channel |
| `rsi` | pane | `period` (14) | fixed 0–100 scale, 30/70 guides |
| `macd` | pane | `fast/slow/signal` (12/26/9) | 2 lines + histogram |
| `stoch` | pane | `period`, `smooth` (14, 3) | %K + %D, fixed 0–100, 20/80 guides |
| `atr` | pane | `period` (14) | Wilder ATR |
| `obv` | pane | – | on-balance volume |
| `cci` | pane | `period` (20) | ±100 guides |
| `wr` | pane | `period` (14) | Williams %R, fixed −100–0, −80/−20 guides |
| `volume` | overlay | – | histogram at the bottom of the price pane |

### Custom indicators

Register your own — anything from a one-liner moving average to a multi-line
pane:

```js
WickChart.registerIndicator('cvwap', {   // cumulative VWAP over the whole dataset
  kind: 'overlay',               // or 'pane'
  params: { period: 20 },        // defaults; set via indicators="cvwap:30"
  compute(bars, params) {        // bars: normalized {time,open,high,low,close,volume}
    const out = new Array(bars.length).fill(null);
    let pv = 0, vv = 0;
    for (let i = 0; i < bars.length; i++) {
      pv += bars[i].close * bars[i].volume;
      vv += bars[i].volume;
      out[i] = vv ? pv / vv : null;
    }
    return out;                  // single series — or { lines:[{name,values}], histogram }
  },
  // pane-only extras: guides:[30,70], range:[0,100], fmt:'price'|'fixed1'|'compact'
});
chart.indicators = 'cvwap';
```

`import WickChart from 'wickchart'` gives you the class for
`WickChart.registerIndicator(...)` (the element is registered as a side effect
of importing the package).

### WickScript — custom indicators as expressions

No build step, no JS: write an indicator inline in the attribute. `expr:{…}`
draws on the price chart; `pexpr:{…}` gets its own pane. Add an optional
`@color`, mix freely with named indicators, and it all round-trips through
shareable URLs.

```html
<wick-chart indicators="sma:20 expr:{(close - sma(close,20)) / sma(close,20) * 100}@ff6a00"></wick-chart>

<!-- oscillator in its own pane -->
<wick-chart indicators="pexpr:{rsi(close,14)} pexpr:{change(close) / close * 100}"></wick-chart>
```

| Series variables | |
|---|---|
| `open` `high` `low` `close` `volume` | raw bar fields |
| `hl2` `hlc3` `ohlc4` | classic derived prices |

| Functions | |
|---|---|
| `sma(x,n)` `ema(x,n)` `wma(x,n)` `stddev(x,n)` | moving stats (window `n` must be a whole number ≥ 1) |
| `rsi(x,n)` | RSI of any series |
| `hh(x,n)` `ll(x,n)` | rolling highest / lowest |
| `prev(x[,k])` `change(x)` | shifted series / bar-to-bar delta |
| `abs(x)` `sqrt(x)` `log(x)` `min(a,b)` `max(a,b)` | element-wise math |
| `crossup(a,b)` `crossdown(a,b)` | 1 on a strict cross, else 0 |
| `vwap()` `obv()` `atr(n)` | bar-level series — callable anywhere, e.g. `crossup(close, vwap())` in alerts |

Operators are `+ - * / %` with usual precedence, unary `-`, and parentheses.
Values before a window fills are `NaN` (not drawn), division by zero yields
`NaN`, and identifiers are case-insensitive.

The expression is compiled by a hand-written tokenizer + recursive-descent
parser in `wickchart/core` — **no `eval`, no `new Function`** — with caps on
length (512), tokens (128) and nesting (24). Invalid scripts are reported via
the parse result's `unknown` list and simply not drawn; they can never execute
anything.

Programmatically, compile once and reuse, or register it under a name for the
attribute syntax:

```js
import { scriptIndicator } from 'wickchart/core';

WickChart.registerIndicator('spread', scriptIndicator('close - ema(close,21)'));
chart.indicators = 'spread';   // now usable like any built-in
```

The demo has a live input for it (type an expression, optionally tick *pane*,
press **+ Expr** — invalid expressions show the compiler's error inline).

### Volatility-regime shading

`<wick-chart volshading>` tints the price pane background by realized
volatility — the rolling stddev of log returns (20 bars by default),
classified against its own full-history percentiles: **calm** (≤ 30th
percentile, subtle blue), **normal** (untinted), **hot** (≥ 70th percentile,
subtle red). Market state at a glance: quiet ranges and violent expansions
read instantly, and the legend shows the hovered bar's regime and
percentile (`VOL 30/70 · hot · 94%ile`).

```html
<wick-chart volshading></wick-chart>                 <!-- defaults 30/70, 20 bars -->
<wick-chart volshading="20/85"></wick-chart>         <!-- custom cutoffs -->
<wick-chart volshading="20/85/50"></wick-chart>      <!-- + 50-bar vol window -->
```

Cutoffs are clamped so the low percentile always stays at least 2 points
below the high one; the toggle and custom cutoffs round-trip through
shareable URLs (`vsh=1` / `vsh=20/85`). A degenerate history (flat series)
classifies everything as normal. The pieces are exported from
`wickchart/core` (`calcRealizedVol`, `volRegimeBands`, `percentileOfSorted`)
if you want to build on them.

### Server-side overlays (zones & levels)

Draw analysis from your own API straight onto the chart: supply/demand
**zones** (time × price rectangles) and horizontal **levels**, rendered
behind the candles. Zones without a `to` extend into future space past the
last bar, like TradingView drawings.

```js
const res = await fetch('https://api.example.com/analysis?symbol=BTC');
chart.setOverlays(await res.json());
```

```js
[
  // zone: from/to are timestamps (ms or s); null → chart edge
  { type: 'zone', from: 1753920000000, priceFrom: 33000, priceTo: 35600,
    color: '#ef5350', alpha: 0.25, label: 'demand' },
  { type: 'zone', from: 1753920000000,                    // no `to` → extends
    priceFrom: 37700, priceTo: 40900, color: '#26a69a' }, // to the right edge
  // level: horizontal price line, full width by default
  { type: 'level', price: 28700, color: '#3f51b5', label: 'S1' },
  { type: 'level', price: 22800, color: '#3f51b5', dash: true },
]
```

- `addOverlay(o)` upserts one (by `id`), `removeOverlay(id)`,
  `clearOverlays()`, and `chart.overlays` reads them back.
- Colors accept hex / `rgb()` / CSS names plus the palette keys
  `up` | `down` | `accent`; `alpha` clamps to 0.02–0.8 (default 0.22).
- Timestamps snap to bars (before the first bar clamps left, after the last
  clamps right); invalid entries are dropped, never thrown — it's API data.
- Fully declarative, too — the same JSON as an attribute:

```html
<wick-chart overlays='[{"type":"level","price":28700,"color":"#3f51b5","label":"S1"}]'></wick-chart>
```

The React binding takes `overlays` as a prop (fresh array → re-apply), and
`normalizeOverlays` / `barIndexForTime` / `resolveOverlayColor` are exported
from `wickchart/core`.

### Scenario mode — ghost paths & volatility cones

Project what-if into future space: a ghost path of hypothetical prices plus
a volatility cone (±1σ/±2σ bands widening with √h from realized vol).

```js
chart.setScenario({
  path: [64000, 65500, 66800, 68000], // prices for future bars 1..N
  cone: true,                         // σ-bands from realized vol (default)
  label: 'bull case',
  color: 'up',                        // up | down | accent or safe colors
});
chart.setScenario({ horizon: 48 });   // cone-only projection
chart.clearScenario();
```

Setting a scenario reserves future space on the right so the cone stays
visible; the horizon defaults to the path length (1–500) and `levels` are σ
multipliers (default `[1, 2]`). Like overlays, scenarios are analysis data —
excluded from shareable state, and the same shape a server-side model could
push. `calcVolCone` / `normalizeScenario` are exported from `wickchart/core`.

### Risk planner — R-multiple grid

Plan the trade on the chart: entry + stop define **1R** (the risk unit) and
reward lines are drawn at kR beyond the entry, with the risk/reward zones
shaded. Direction is derived from the stop side.

```js
chart.setRiskPlan({ entry: 64500, stop: 63800, multiples: [1, 2, 3] });
chart.setRiskPlan({ entry: 64500, stop: 63800, targets: [65900, 67300] }); // prices → kR
chart.clearRiskPlan();
chart.riskPlan; // { entry, stop, risk, direction, levels: [{ k, price }], maxK, label }
```

Explicit `targets` convert to their R multiple (wrong-side prices drop);
`multiples` win when both are given. At most 8 levels, each ≤ 20R; invalid
specs clear the plan, never throw. `normalizeRiskPlan` is exported from
`wickchart/core`.

### Bar-walk narrator — history as a story

`narrate()` builds the timeline of a window (pivot highs/lows, volume
spikes, gaps, RSI divergences, plus derived legs — the move between
opposite pivots); `walk()` replays the chart through it while `wick:walk`
events announce each step, so a caption bar can narrate the replay.

```js
chart.narrate();                 // [{ i, time, type, note, legPct?, legBars? }]
chart.walk({ from: 0, to: 500, speed: 120, step: 10 });
chart.addEventListener('wick:walk', (e) => {
  // { phase: 'step' | 'end' | 'stop', index, events: [...], from, to }
});
chart.stopWalk();                // any pointer/wheel/key input stops it too
```

`narrateWindow` (the analyzer) is exported from `wickchart/core`.

### Delta brush — drag-select with stats

`<wick-chart brush>` makes a plain drag **select bars** instead of panning:
a live band follows the pointer with a delta chip (Δ% · bars · high · low ·
Σvol); on release the selection commits and fires `wick:brush` with the
range statistics. Esc (or `clearBrush()`) clears it.

```html
<wick-chart brush></wick-chart>
```

```js
chart.addEventListener('wick:brush', (e) => {
  // { bars, from: {index, time}, to: {index, time}, delta, deltaPct,
  //   firstOpen, lastClose, high, low, volume }
});
chart.brushSelection; // { i0, i1, stats } | null
chart.clearBrush();
```

Brush mode replaces plain-drag panning (shift-drag still measures);
replacing the dataset clears a committed selection. `brushStats` is
exported from `wickchart/core`.

### Story mode — guided tours of chart state

A **story** is an array of **scenes** (view range, type, indicators,
overlays, scenario, risk plan + title/note). `playStory()` applies each
scene, eases the camera to its range, holds for `dwell`, and narrates
through `wick:story`. Record scenes with `captureScene()` while you
arrange the chart, or generate them from an analysis.

```js
const story = [chart.captureScene('Overview', 'the full picture')];
story.push({ title: 'The breakout', range: { from, to }, indicators: 'sma:20' });
chart.playStory(story, { dwell: 2200, panMs: 900, loop: false });
chart.addEventListener('wick:story', (e) => {
  // { phase: 'scene' | 'end' | 'stop', index, total, scene, title, note }
});
chart.stopStory(); chart.getStory();
```

Any user interaction stops the tour. Scenes are plain data — serialize
or share them. `normalizeScene` / `sceneList` / `easeInOutCubic` are
exported from `wickchart/core`.

### AI-ready data window — `getDataWindow()`

One call turns whatever is on screen into a compact, LLM-pasteable summary.
Everything is computed locally from the visible bars — trend (least-squares
drift + fit), realized-vol percentile, SMA/RSI snapshot, up/down bar mix,
volume profile notes, and the same pattern detection that powers smart
annotations (gaps, spikes, pivots, divergences). Nothing leaves the page
until you copy it somewhere.

```js
const s = chart.getDataWindow();
s.text;      // markdown — ready to paste into any AI chat
s.trend;     // { label: 'strong uptrend', slopePctPerBar: 0.77, r2: 0.94 }
s.volPctile; // 84 → hot regime relative to the window itself
s.patterns;  // [{ time, note }] — most recent first
```

### AI agent interface — the chart as a tool surface

The chart can publish its own **tool manifest** and accept validated
tool-calls, so any LLM can operate it with zero glue code — the chart never
touches the network; you supply the model call.

```js
chart.aiTools();    // manifest: get_data_window, set_indicators, set_overlays, add_alert, …
chart.aiPrompt();   // system prompt demanding JSON [{tool, args}] ops
chart.aiContext();  // grounding: current state + visible-window summary
chart.applyAI(ops); // validated dispatcher — per-op {ok, result} / {ok:false, error}

const { results } = await chart.ask(
  'add RSI, mark the demand zone, and alert me on volume spikes',
  { run: async (payload) => (await callMyLLM(payload)).ops }
);
```

Every op is whitelisted and its args validated (indicator names checked
against the registry, overlays through the sanitizer, enums enforced) — LLM
output is treated as untrusted input, and a bad op returns an error the
model can self-correct from instead of throwing. The
[docs page](./docs.html) has a live playground driving `applyAI()` with an
offline demo agent (no network, no keys).

`text` renders like:

```
CHART SUMMARY — BTC · 1h · 214 bars · 2026-08-21 → 2026-09-07
- Close 97.03 (−1.20% over window). High 104.20 on 2026-08-28, low 91.40 on 2026-09-01. Max drawdown 8.1%.
- Trend: downtrend (drift −0.061%/bar, fit r² 0.58). Price below SMA20 (99.10). RSI(14) 41.3.
- Volatility: annualized 48%; latest realized vol at the 84th percentile of the window (hot regime).
- Bars: 96 up / 117 down. Volume avg 1.2K/bar, peak 8.9K on 2026-09-01.
- Notable: Gapped down −1.42% (2026-09-01); Volume 4.1× average (2026-09-03).
```

The demo's **Explain** button shows this in a panel with a one-click copy.
The pure function behind it (`windowSummary(bars, i0, i1, opts)`) is exported
from `wickchart/core` for server-side use.

### Sonification — the chart by ear

`<wick-chart sonify>` maps price to pitch (180–880 Hz across the visible
scale, log-aware): moving the crosshair with the mouse or **arrow keys** plays
a short tone per bar, so trend and shape are audible — a rare accessibility
win for screen-reader users. `chart.playRange()` sweeps the whole visible
range as a ~4-second pitch sequence, riding the crosshair along for sighted
users. Audio starts lazily within the enabling user gesture (autoplay-policy
safe).

### Cross-tab co-view & presence

Tag charts with the same channel and they share pointers — across browser
tabs, or between multiple charts on one page:

```html
<wick-chart co-view="btc-room" co-view-name="ben"></wick-chart>
```

Hovering in one tab draws a ghost crosshair (accent, dotted, with the time
pill) in every peer. Positions are synced by bar **time**, so peers with
different history depths still line up. Ghosts fade ~2.5 s after the peer
stops moving. Same-origin only (BroadcastChannel); the connection follows the
`co-view` attribute and closes with the element.

Peers also see **where everyone is looking**: each peer's viewport renders
as a colored band (with name) along the top of the plot, updated live as
they pan or zoom and swept away ~12 s after they go quiet.

```js
chart.getPeers(); // [{ id, name, range: { from, to }, at }]
chart.addEventListener('wick:peers', (e) => {
  // { peers, joined, left } — membership changes only
});
```

`PresenceTracker` (the TTL bookkeeping) is exported from `wickchart/core`
for apps that sync presence over their own transport instead.

### Smart annotations

`<wick-chart annotations>` marks notable events on the visible range — volume
spikes (>3× average), price gaps, 41-bar pivot highs/lows, and RSI
divergences — with lettered badges (V/G/H/L/D). Hover a badged bar and the
legend shows a one-line insight ("Volume 4.2× average", "Bearish RSI
divergence"). The current set is emitted on every recompute via the
`wick:annotations` event, so hosts can build their own UI from it. Badges are
hidden at extreme zoom-out, where bars collapse into columns.

### Example: VWAP via the registry

VWAP ships in the demo but *not* as a builtin — it's the reference for writing
your own (session-anchored, resets each trading day):

```js
import WickChart from 'wickchart';

WickChart.registerIndicator('vwap', {
  kind: 'overlay',
  params: {},
  compute(bars) {
    const out = new Array(bars.length).fill(null);
    let pv = 0, vv = 0, day = -1;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const d = new Date(b.time).setHours(0, 0, 0, 0);
      if (d !== day) { day = d; pv = 0; vv = 0; }
      const tp = (b.high + b.low + b.close) / 3;
      pv += tp * b.volume;
      vv += b.volume;
      out[i] = vv ? pv / vv : null;
    }
    return out;
  },
});
chart.indicators = 'vwap';
```

### Plugin layers — extend without forking

`addLayer()` is the whole extension surface: an external draw hook that paints
into the render pipeline (above chart content, under the crosshair) and can
claim pointer gestures so drags reach your code instead of panning the chart.
Four public coordinate transforms — `timeToX`/`xToTime` (extrapolating past
the last bar into future space) and `priceToY`/`yToPrice` — anchor your
content in data space so it rides along with zoom and pan:

```js
chart.addLayer({
  id: 'flags',
  draw(api) {
    const x = api.timeToX(t), y = api.priceToY(p); // anchors, not pixels
    api.ctx.fillStyle = api.palette.accent;
    // …paint in CSS pixels
  },
  onPointer(ev) {
    if (ev.type === 'down' && hitsMyContent(ev)) return true; // claim the drag
  },
});
chart.requestDraw();        // repaint hook for interactive layers
chart.removeLayer('flags'); // detach by handle or id
```

A claimed gesture delivers `move`/`up` (and `cancel` on Escape) to the layer
while the chart suppresses pan/brush/measure. Markers, watermarks, signal
badges — or a whole drawing toolkit — plug in without the core growing a
single tool. The main entry is covered by a CI gzip budget (68 KB) so it
stays that way.

### Drawings — the `wickchart-draw` plugin

The first official plugin: TradingView-style drawing tools as opt-in bytes
(~8 KB gz, own CI budget). Trendlines (segment/ray), horizontal levels,
rectangles, fibonacci retracements and text — all plain `{ time, price }`
data that rides zoom & pan, survives reloads, extrapolates into future
space, and serializes to JSON. Anchors magnet-snap to bar times and OHLC.

```js
npm install wickchart wickchart-draw   // drawings are a separate opt-in package

import { attachDrawings } from 'wickchart-draw';

const draw = attachDrawings(chart);
draw.setTool('trendline'); // drag to draw; setTool(null) = select/move mode
draw.getDrawings();        // → JSON array (save it); setDrawings(saved)
draw.undo(); draw.clear();
draw.setShare(true);       // shared drawings: draw on one tab, appears on all
chart.addEventListener('wick:drawings', (e) => save(e.detail.drawings));
```

Select mode: click a drawing to select it, drag to move, drag the square
handles to re-anchor, `Delete` removes, `Esc` cancels a gesture; clicks on
empty space fall through to the chart. Placing a note opens an inline editor
(type + `Enter`); click a selected note again to re-edit. `setShare(true)`
reuses the chart's `co-view` room (or pass an explicit room name) — last
writer wins, remote updates never touch the local undo stack. Peer
dependency: wickchart ≥ 1.4. See the live playground in the docs (Drawings
section — it shares a room, so open it twice and draw on either chart).

### Sessions — the `wickchart-sessions` plugin

Market session shading as opt-in bytes (~6 KB gz, own CI budget): Asia /
London / New York and other sessions drawn as translucent bands, with labels,
closed-weekend shading for equities/futures, and crosshair hover events.
Presets for crypto & forex use the common UTC convention; equity/futures
presets use IANA timezones, so 09:30 is the real 09:30 across DST changes.
Custom defs (`{ name, start, end, tz?, days?, color?, alpha? }`) cover
midnight-crossing sessions and weekday filters.

```js
npm install wickchart wickchart-sessions   // sessions are a separate opt-in package

import { attachSessions } from 'wickchart-sessions';

const sessions = attachSessions(chart, { preset: 'crypto' });
sessions.setPreset('nyse');   // 'crypto' | 'forex' | 'nyse' | 'cme' | null
sessions.setSessions([...]);  // custom defs (validated; getSessions() → JSON)
sessions.setWeekends(true);   // shade closed Sat+Sun (default for nyse/cme)
chart.addEventListener('wick:sessions', (e) => status.textContent = e.detail.hover || '');
```

The hover bridge listens to the chart's own crosshair events, so shading
never claims a pointer gesture — pan/zoom/measure work untouched. Peer
dependency: wickchart ≥ 1.4.

### Replay — the `wickchart-replay` plugin

Bar replay as opt-in bytes (~3 KB gz, own CI budget): play history forward
bar-by-bar or at speed while the future stays hidden. The whole engine runs
on the public data API — a `setData` slice hides the future, `update()`
appends one bar per step — so the core stays replay-free. A badge layer shows
the mode and position at a glance.

```js
npm install wickchart wickchart-replay   // replay is a separate opt-in package

import { attachReplay } from 'wickchart-replay';

const replay = attachReplay(chart);
replay.start();               // head at ~70% of the data (or pass a time/index)
replay.play();                // 4 bars/sec — play(15) for faster, pause() stops
replay.step();                // reveal one bar
replay.seek('2026-03-06');    // jump the head
replay.setLoop(true);         // wrap to the anchor at the end
replay.stop();                // exit — the full dataset is restored
chart.addEventListener('wick:replay', (e) => progress.textContent =
  e.detail.active ? `${e.detail.index + 1}/${e.detail.total}` : '');
```

Anchors accept bar indices, timestamps (ms/s) or date strings; every change
fires `wick:replay` with the full state. Pause live feeds while replaying —
an external `update()`/`setData()` aborts replay instead of corrupting the
chart (the demo pauses its feed automatically). Paper trading and an equity
curve are the planned 0.2 follow-up. Peer dependency: wickchart ≥ 1.4.

### Compare — the `wickchart-compare` plugin

Normalized multi-asset overlays as opt-in bytes (~4 KB gz, own CI budget):
percent-rebased compare lines (ETH against BTC, TradingView-style) plus
derived **ratio** and **diff** lines (`BTC/ETH`, `BTC−ETH`), drawn over the
main pane against their own invisible scale so the price axis is untouched.
A legend chip row shows each series with its live value.

```js
npm install wickchart wickchart-compare   // compare is a separate opt-in package

import { attachCompare } from 'wickchart-compare';

const cmp = attachCompare(chart);
cmp.setSeries([
  { label: 'ETH', data: ethBars },                            // OHLC or {time, value}
  { label: 'BTC/ETH', op: 'ratio', a: btcBars, b: ethBars },  // derived
]);
cmp.setRebase('visible');   // 0% at the window edge, re-normalized while
                            // panning; 'first' or an epoch anchor also work
cmp.clear(); cmp.detach();
```

Series are sampled onto the main chart's bar times, so timeframes can mix
and gaps break the line instead of bridging. Rebased values share one
invisible scale inset 8% from the pane edges; the price scale is never
distorted. Validated, capped at 6 series, invalid entries dropped. Peer
dependency: wickchart ≥ 1.4.

### Navigator — the `wickchart-navigator` plugin

The most-missed TradingView affordance: a silhouette of the whole dataset
docked below the chart with a draggable viewport window (~3 KB gz, own CI
budget). Drag the window to pan, grab an edge to resize, click outside it to
jump — pan/zoom and the window stay in sync live, both directions.

```js
npm install wickchart wickchart-navigator   // navigator is a separate opt-in package

import { attachNavigator } from 'wickchart-navigator';
const nav = attachNavigator(chart, { height: 46 }); // strip height, 24..120
nav.detach();                                       // remove the strip again
```

The strip needs bottom space, so this plugin pairs with a small core hook:
a layer may declare `insetBottom` (px) — the largest declared inset reserves
a docked strip at the bottom of the canvas, panes and the time axis shrink
above it, and layers draw it as `api.layout.dock`. On charts without the
hook the navigator degrades silently. The silhouette is O(n) once per
(dataset, width) and cached. Peer dependency: wickchart ≥ 1.6.

### Alerts+ — the `wickchart-alerts-plus` plugin

The "pro" alert tier (~3 KB gz, own CI budget). Core alerts are runtime-only
by design; this adds what a trading tool actually needs, without the core
growing any of it: **persistence** (the alert list mirrors into
localStorage and re-arms on reload), **desktop notifications + a WebAudio
beep** while the tab is hidden, and an optional **webhook** that receives
every fire as `POST { id, price, when, time, bar, key }`.

```js
npm install wickchart wickchart-alerts-plus   // alerts-plus is a separate opt-in package

import { attachAlertsPlus } from 'wickchart-alerts-plus';
const ap = attachAlertsPlus(chart, {
  key: 'BTC:1h',                       // one storage key per symbol+timeframe
  notify: true, sound: true,           // hidden-tab surfacing
  webhook: 'https://example.com/hook', // optional
});
await ap.requestNotify();              // ask for the notification permission
ap.add({ price: 100, direction: 'above' });  // persisted, re-armed on reload
ap.add({ when: 'rsi(close,14) < 30' });      // scripted alerts persist too
ap.list(); ap.remove(id); ap.clear(); ap.sync(); ap.detach();
```

Once-fired alerts drop out of storage automatically; alerts added directly
on the chart are captured at the next save point; storage/fetch are
injectable and every storage failure degrades to memory-only, never
throwing. Peer dependency: wickchart ≥ 1.4.

### Layouts — the `wickchart-layouts` plugin

Named workspace persistence (~3 KB gz, own CI budget): save and restore
whole chart setups by name — type, theme, log scale, toggles, indicators,
view range, positions, alerts — plus the drawing list when wickchart-draw
is attached. Everything rides the core's public `getState()`/`setState()`.

```js
npm install wickchart wickchart-layouts   // layouts is a separate opt-in package

import { attachLayouts } from 'wickchart-layouts';
const layouts = attachLayouts(chart, {
  key: 'my-desk',      // storage key (default 'wickchart-layouts')
  drawings: draw,      // optional wickchart-draw handle — include drawings
});
layouts.save('swing');    // capture the current setup under a name
layouts.load('swing');    // apply it back
layouts.list();           // → [{ name, at, drawingCount }] newest first
layouts.export();         // → JSON string — share it, store it anywhere
layouts.import(json);     // merge layouts back (replaces same names)
chart.addEventListener('wick:layouts', (e) => console.log(e.detail.action, e.detail.name));
```

Entries are capped (oldest evicted), `storage` is injectable, storage
failures degrade to an in-memory store for the session and never throw.
Pair a `load` with `wickchart-alerts-plus`'s `sync()` if you also persist
alerts, since a layout load replaces the chart's alert list. Peer
dependency: wickchart ≥ 1.4.

### Signals — the `wickchart-signals` plugin

Candlestick pattern badges (~4 KB gz, own CI budget): bullish/bearish
**engulfing**, **pin bars** (hammer / shooting star) and **inside bars**
drawn as direction-colored letter chips above/below the bar. Hover a badged
bar and the plugin draws the explanation ("Bullish engulfing") and fires
`wick:signals` — the same passive crosshair bridge as wickchart-sessions,
so badges never claim a pointer gesture.

```js
npm install wickchart wickchart-signals   // signals is a separate opt-in package

import { attachSignals } from 'wickchart-signals';
const signals = attachSignals(chart);
signals.setKinds(['engulfing', 'pinbar']); // subset (default: all three; [] = off)
signals.setLabels(false);                  // hover explanations off
chart.addEventListener('wick:signals', (e) => status.textContent = e.detail?.label || '');
```

Detection is O(n), cached per dataset and kind subset — pan/zoom are pure
repaints. Peer dependency: wickchart ≥ 1.4.

### Tape — the `wickchart-tape` plugin

Time & sales (~4.6 KB gz, own CI budget): a live trade-print strip docked at
the bottom of the canvas through the `insetBottom` hook — `time · price ·
size` rows colored by side with proportional size bars, oversized prints
highlighted. Display-only: it never claims a pointer gesture. Prints carry
an optional side; without one the plugin applies the classic **tick rule**
(uptick → buy, downtick → sell), carried continuously across pushes. The
same stream drives the chart: `chart.setData(tape.toBars(60000))`.

```js
npm install wickchart wickchart-tape   // tape is a separate opt-in package

import { attachTape } from 'wickchart-tape';
const tape = attachTape(chart, { rows: 7, bigSize: 50 });
socket.onmessage = (m) => tape.push(m.trades); // single print or batch
tape.setRows(4); tape.hide(); tape.detach();   // rows 3–8; hide frees the dock
chart.addEventListener('wick:tape', (e) => status.textContent = e.detail.total + ' prints');
```

Keeps the newest 500 prints. Peer dependency: wickchart ≥ 1.6 (the dock
hook); shares the bottom strip with wickchart-navigator, so attach one or
the other.

## Methods

| Method                          | Description                                      |
| ------------------------------- | ------------------------------------------------ |
| `setData(bars)`                 | Replace the dataset (sorted automatically)        |
| `update(bar)`                   | Stream: replaces last bar or appends a new one    |
| `clearData()`                   | Empty the chart                                   |
| `fit()`                         | Reset zoom to the default view (~150 bars)        |
| `getVisibleRange()`             | → `{ from, to }` (ms timestamps)                  |
| `setVisibleRange({from, to})`   | Jump to a time window                             |
| `exportPNG()`                   | → PNG data URL of the current canvas              |
| `getDataWindow()`               | → AI-ready summary of the visible window (see below) |
| `getState()`                    | → serializable snapshot (type, indicators, view, positions, alerts) |
| `setState(state)`               | Apply a snapshot; a pending view applies after the next `setData()` |
| `addLayer(layer)` / `removeLayer(idOrHandle)` | Register/detach a plugin layer (draw hook + optional pointer claim + optional `insetBottom` dock strip) |
| `requestDraw()`                 | Repaint on the next frame (interactive layers)     |
| `timeToX(t)` / `xToTime(x)`     | Bar time ⇄ x-pixel; extrapolates into future space |
| `priceToY(p)` / `yToPrice(y)`   | Price ⇄ y-pixel in the main pane (log-aware)       |

### Infinite history (`loadMore`)

Assign a callback and the chart fetches older bars whenever the user scrolls
toward the left edge — the view stays anchored while data is prepended:

```js
chart.onloadmore = async (fromTime) => {
  const res = await fetch(`/api/bars?before=${fromTime}&limit=500`);
  return res.json(); // [{ time, open, high, low, close, volume }, …]
};
```

Return an empty array (or throw) when history is exhausted and the chart stops
asking. Data gaps (weekends, session breaks) are marked with subtle dashed
dividers on the time axis.

### Positions & alerts

Visualize trades directly on the chart — entry/stop/target zones, a live P&L
chip, and price alerts that fire during streaming updates:

```js
chart.addPosition({ side: 'long', entry: 64200, stop: 62900, target: 66800, qty: 0.5 });
chart.addPosition({ id: 'x1', side: 'short', entry: 66000, qty: 1 });
chart.removePosition('x1');

chart.addAlert({ price: 65000, direction: 'above' }); // 'above' | 'below' | 'cross'
chart.addEventListener('wick:alert', (e) => {
  console.log('crossed!', e.detail.id, e.detail.price);
});

// scripted alerts — any WickScript predicate, fired on its false→true edge
chart.addAlert({ when: 'crossup(rsi(close,14), 30)' });
chart.addAlert({ when: 'volume > sma(volume,20) * 3', once: false }); // re-arms

// evaluate only on final candles, so the signal cannot repaint
chart.addAlert({ when: 'crossup(rsi(close,14), 30)', evaluate: 'close' });
```

The P&L chip recalculates on every streamed bar. Alerts are edge-triggered
(fire once per crossing) and one-shot by default (`once: false` to re-arm).
Scripted alerts are evaluated locally on every streamed bar — the event
carries the triggering close as `price` plus the `when` source; an invalid
predicate is rejected (`addAlert` returns `null`), never thrown.

**Live vs closed-candle evaluation.** Alerts evaluate on every update by
default, the still-forming candle included — so a technical signal can
repaint (RSI crosses 30 mid-candle, price reverses, the candle closes back
above 30). Pass `evaluate: 'close'` to fire only on final candles, or set
`<wick-chart alert-evaluate="close">` as the chart-wide default (per-alert
`evaluate` still wins). A candle is final once a newer bar arrives, or as
soon as the feed says so via `closed: true` on `update()` — `<wick-feed>`
forwards Binance's `k.x` flag, so the signal lands at the close rather than
one candle later. Historical corrections and backfilled candles never fire
live alerts in either mode.

### Timezone & VWAP sessions

Axis labels and the crosshair readout use the viewer's timezone by default.
Pin them with `timezone` — `local`, `utc`, or any IANA zone, DST included:

```html
<wick-chart timezone="Europe/Stockholm"></wick-chart>
<wick-chart timezone="America/New_York"></wick-chart>
```

Day dividers and month/year ticks follow the chosen zone, so a "1 Feb" tick
is 1 February *there*. An unrecognised zone falls back to UTC and warns once.

VWAP's session boundary is deliberately **separate** from the display zone —
changing the axis to Stockholm shouldn't silently re-anchor a BTC chart. It
defaults to the UTC day (the crypto convention) and moves only when asked:

```html
<wick-chart indicators="vwap" vwap-anchor="America/New_York"></wick-chart>
```

`vwap-anchor` takes `utc` (default), `local`, an IANA zone, or a fixed offset
in milliseconds. Equities, futures and FX rarely open at UTC midnight, so the
default is right for crypto and wrong for most other markets — set it
deliberately. `calcVWAP(bars, anchor)` takes the same values directly.

### Stats & measure

`<wick-chart stats>` shows live statistics of the visible range — return %,
max drawdown, annualized volatility, up/down bar counts, average volume —
recalculated as you pan and zoom.

Hold **Shift and drag** across the chart to measure a move: an overlay shows
Δprice, Δ%, bar count and elapsed time, and a `wick:measure` event fires on
release (`detail.from` / `detail.to` carry index, time and price). Click or
press `Esc` to clear.

### Shareable URLs

`getState()` / `setState()` serialize everything about the chart, and
`encodeStateQuery` / `decodeStateQuery` (exported from `src/core.js`) turn a
state into a compact query string — the demo maps it to the page hash, so any
chart configuration is one link away:

```js
import { encodeStateQuery, decodeStateQuery } from 'wickchart/core';

const link = `${location.origin}#${encodeStateQuery(chart.getState())}`;
history.replaceState(null, '', link);
// later, on load:
chart.setState(decodeStateQuery(location.hash.slice(1)));
```

Reflected properties (`chart.type = 'line'`) work for `theme`, `type`, `label`,
`indicators`.

## Events

| Event           | Detail                                                     |
| --------------- | ---------------------------------------------------------- |
| `wick:crosshair` | `{ index, bar, x, y, price }` on hover / arrows, `null` on leave |
| `wick:range`     | `{ from, to }` after zoom / pan / jump                      |
| `wick:select`    | `{ index, bar, price }` on click/tap (e.g. open an order form at that price) |

## Theming

All colors are CSS custom properties settable on the element (they pierce the
Shadow DOM):

```css
wick-chart {
  --wick-bg: #0d1117;          /* transparent works too */
  --wick-up: #16c784;
  --wick-down: #ea3943;
  --wick-accent: #4c8dff;      /* line & area color */
  --wick-text: #8b949e;        /* axis text */
  --wick-text-strong: #e6edf3; /* legend values */
  --wick-grid: rgba(230,237,243,.05);
  --wick-border: rgba(230,237,243,.09);
  --wick-crosshair: rgba(230,237,243,.42);
  --wick-rsi: #a78bfa;
  --wick-overlay-0: #f0b429;   /* SMA color, …-1, -2, … for more overlays */
}
```

## Interactions

| Gesture                    | Action                              |
| -------------------------- | ----------------------------------- |
| Mouse wheel / trackpad ⌘+scroll | Zoom, anchored at the cursor    |
| Trackpad horizontal scroll | Pan                                 |
| Drag                       | Pan (auto-follow re-arms at the right edge) |
| Pinch (touch)              | Zoom                                |
| Long press (touch)         | Open the crosshair, then drag to scrub across bars |
| Vertical swipe (touch)     | Scrolls the page, not the chart     |
| Double-click / double-tap  | Reset view                          |
| `←` `→` (`+Shift` ×10)     | Move crosshair                      |
| `+` / `−`                  | Zoom in / out                       |
| `Home` / `End`             | Jump to oldest / newest             |
| `Esc`                      | Clear crosshair                     |

## Performance

Canvas 2D with a rAF-batched, visible-range-only render pipeline. Measured on a
desktop (Chromium, 1100×760, all indicators on: SMA + EMA + RSI + volume):

| Scenario                                  | Per full render |
| ----------------------------------------- | --------------- |
| 600–50,000 bars, default view (~150 visible) | **~0.2 ms**  |
| 5,000 bars, max zoom-out (~2,900 visible)  | ~6 ms           |
| 50,000 bars, max zoom-out (~3,100 visible) | ~16 ms          |
| Streaming tick (update + full re-render)   | 0.5–19 ms       |

A 60 fps frame budget is 16.7 ms, so the default view uses ~1% of a frame.
Hot paths are deliberately allocation-light: date labels are built lazily only
for actual axis ticks (with cached `Intl.DateTimeFormat`s), and candles/volume
are drawn in two batched passes by direction instead of one draw call per bar.

**Deep zoom-outs are columnar**: when more bars are visible than ~1.5× the
pixel width, bars aggregate into per-pixel min/max columns (first open / max
high / min low / last close / summed volume), so rendering any history at any
zoom costs O(screen width), not O(bars). The minimum zoom level adapts to the
dataset — every chart can be zoomed out until the entire history fits.

If you ever push past this (100k+ simultaneously visible bars, dozens of
series, high-frequency ticks), the scaling levers are: incremental indicator
updates (SMA/EMA/RSI are O(1) online), min/max columnar downsampling per pixel
column, and an offscreen layer so hover only repaints the crosshair.

## Architecture notes

- Single ES module, Custom Element + Shadow DOM, Canvas 2D with
  devicePixelRatio scaling and rAF-batched invalidation. The ratio is watched
  with a `resolution` media query, so moving a window between monitors
  re-renders at the new resolution rather than staying soft
- Only visible bars are drawn; indicator series are computed lazily and cached
  per data version (prefix-sum SMA, Wilder RSI)
- Time axis picks tick steps from bar interval (minutes → months) and labels
  day/month boundaries like a pro terminal
- No dependencies, no build step required — but it bundles/tree-shakes fine

## Tests

Two suites, and they answer different questions.

```bash
npm test          # Node: pure functions, indicator maths, parsing, plugins
npm run test:e2e  # Playwright: the chart in a real browser
```

`npm test` is the fast one and covers the bulk of the library. What it cannot
reach is anything that only exists once a browser is involved: custom-element
upgrade, a real canvas, wheel/pointer/touch input, `devicePixelRatio`,
`ResizeObserver`, and React re-renders against a live DOM node. Bugs have
shipped in exactly that gap — a React parent re-render used to silently reset
the user's zoom, and a chart moved to a monitor with a different pixel ratio
kept rendering at the old resolution. Both are covered in `e2e/` now.

The browser suite serves the repository over a small dependency-free static
server (`e2e/server.mjs`) and loads the library from source, so it tests the
files that ship rather than a build artifact. The React fixture pulls React
from esm.sh, the same way `demo/react.html` does.

**Running it locally.** `npm run test:e2e` downloads Playwright's bundled
Chromium the first time. If that CDN is blocked on your machine, point the
suite at a browser you already have:

```bash
WICK_E2E_CHANNEL=chrome npm run test:e2e     # or msedge
```

**Visual regression** is opt-in. Canvas output is not pixel-identical across
operating systems, so a committed baseline from one machine red-lights
everyone else; the rest of the suite compares the chart against *itself*
instead (repaint X, assert only what should have moved did). To gate on real
screenshots, generate baselines on the platform that will run them:

```bash
WICK_E2E_VISUAL=1 npm run test:e2e -- --update-snapshots
```

## Roadmap ideas

- More overlays (Bollinger, VWAP), MACD pane, drawing tools
- Data callbacks (`loadMore` for infinite history)
- Incremental (O(1)) indicator updates for high-frequency streaming
- Min/max downsampling and/or an offscreen hover layer if profiling ever demands

## Migrating from 0.x (HabView)

1.0 renames the public surface to the WickChart brand. The 0.x names keep
working as **deprecated aliases** (removed in 2.0), so upgrading is safe to
do lazily:

| 0.x (deprecated alias) | 1.0 canonical |
|---|---|
| `<hab-chart>` / `<hab-feed>` | `<wick-chart>` / `<wick-feed>` |
| `hab:range`, `hab:select`, `hab:alert`, `hab:crosshair`, `hab:measure`, `hab:annotations` | `wick:*` of the same name (both fire during 1.x) |
| `hab-feed:status` / `hab-feed:fallback` | `wick-feed:status` / `wick-feed:fallback` (both fire during 1.x) |
| `--hab-bg`, `--hab-up`, … | `--wick-*` of the same name (`--wick-*` wins; `--hab-*` is the fallback) |
| `HabChart` / `HabFeed` classes | `WickChart` / `WickFeed` (also as named exports) |
| HabScript (the `expr:{…}` language) | WickScript — syntax unchanged |
| `import … from 'wickchart/src/hab-chart.js'` | use the package entry points (`wickchart`, `wickchart/core`, `wickchart/feed`) — module files are renamed |

Two behavioral notes: custom indicators registered via
`WickChart.registerIndicator()` are shared with the legacy `<hab-chart>`
alias (one registry), and cross-tab co-view channels are now prefixed
`wick-co-view:` (a 0.x tab and a 1.x tab won't pair — refresh both).

## License

MIT
