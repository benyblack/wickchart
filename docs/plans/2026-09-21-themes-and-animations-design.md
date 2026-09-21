# Design: `registerTheme()` + live-price easing plugin

Date: 2026-09-21 · Status: **proposed (awaiting approval)** · Scope: v2.3.0 candidates

## Context

wickchart 2.2.0 (~67 KB gz of a 68 KB CI budget) themes via `theme="dark"|"light"`
plus ~25 `--wick-*` CSS variables resolved in `_palette()` (`wick-chart.js`). A
branded look today means re-declaring the variables at every page/chart; there is
no named custom theme. Rendering is a single immediate-mode canvas redraw batched
on one rAF (`_invalidate()` → `_render()`); no tweening exists anywhere. All tick
sources (app code, `<wick-feed>` WebSocket/synthetic/poll, paper trading) funnel
through `chart.update(bar)`, where a same-`time` tick replaces the forming bar.

## Goals

1. `registerTheme(name, palette)` — named custom themes usable as `theme="name"`.
2. Live-price easing (candle body, last-price line, axis label, legend, stats
   glide on each tick) — **opt-in, out of core**, as a plugin package.

## Non-goals

- Zoom/pan glide, theme cross-fades, chart-type transitions (deferred).
- Easing on `setData` / history loads — live ticks only.
- Auto-follow of `prefers-color-scheme` for the theme attribute.

## A. `registerTheme()` — core, ~50 lines (≈ +0.3 KB gz)

### API

```js
import { registerTheme } from 'wickchart';        // also from 'wickchart/core'
registerTheme('matrix', { up: '#22c55e', down: '#ef4444', bg: '#000000', /* partial */ },
              { base: 'dark' });                  // default base: 'dark'
// then: <wick-chart theme="matrix"> or chart.theme = 'matrix'
```

### Semantics

- **Merge at register time** over the base palette; only known palette keys are
  kept (unknown keys dropped); `volAlpha` coerced to number. Partial palettes are
  the point — a theme is a handful of diffs over `dark`/`light`.
- **Re-registering a name overwrites** and bumps a module-level registry version;
  `_palette()` cache key (`_palKey`) includes that version so an overwrite
  re-resolves on the next render.
- **Attribute coercion** (`wick-chart.js` `attributeChangedCallback` `theme`
  case): pass through any registered name; unknown values fall back to `dark`
  (today anything not `light` is coerced to `dark`, so behavior for unregistered
  values is unchanged). `_palette()` already resolves `THEMES[name] || dark`.
- **CSS variables still win**: resolution order stays base → registered palette
  → `--wick-*` overrides. Registered themes compose with per-page CSS tweaks.
- **Report export fix**: `report.js` ships its own `PALETTES` copy and reads
  `--wick-*` in `auto` mode, so a registered theme would export wrong colors.
  `reportColors()` gains a registry lookup (exported `getTheme(name)` from
  core) so `exportReport` follows the chart's registered theme; the CSS-var
  override layer stays on top.
- **Layouts/presets** persist `theme` as an opaque string — registered names
  round-trip with no changes.
- Exports: `registerTheme` from `wickchart` and `wickchart/core` (next to
  `THEMES`).

### Budget & tests

~+0.3 KB gz of the ~1 KB headroom (67 → ~67.3 of 68). Unit tests: partial merge,
unknown-key drop, overwrite + cache re-resolution, attribute passthrough +
unknown-name fallback, CSS var precedence over registry, report colors for a
registered theme. README/docs.html theming sections updated.

## B. `plugins/animate` — `wickchart-animate`, zero core bytes

### API

```js
import { attachAnimate } from 'wickchart-animate';
const anim = attachAnimate(chart, { duration: 180 });   // default 180ms, ease-out cubic
anim.detach();
// opts: duration (0 = passthrough), easing (fn(t) or named), volume (true = ease volume too; default false)
```

### Mechanics

- **Wrap `chart.update` on the instance** (`plugins/replay` precedent: plugins
  drive the chart through the public data API; here we intercept it). Eased
  frames re-enter through the saved original, bypassing the wrapper. `detach()`
  restores the original method.
- On each real tick on the forming bar: record `from` (last rendered close —
  i.e. current eased value if mid-flight, else the bar's close), `to` (new
  close), `t0`; run a rAF loop writing `update({ ...bar, close: lerp(from, to,
  e) })` each frame until settled; the final frame writes the true bar.
- **Retarget, never jump**: a new tick mid-ease replaces `to`/`t0` with
  `from` = current eased value.
- **Wick guard**: eased frames send `high = max(bar.high, easedClose)` and
  `low = min(bar.low, easedClose)` so the body never escapes its wick. Open,
  volume (unless `volume: true`) pass through as facts.
- **Backfill/out-of-order ticks** (`bar.time < last.time`): pass through
  un-eased — historical corrections are facts.
- **Cancel on data moving underneath**: each eased frame verifies the chart's
  last bar still matches the eased bar (time + length sanity) before writing;
  otherwise cancel (covers `setData` / `clearData` mid-ease).
- **`prefers-reduced-motion`** (checked at attach + on change) and
  `duration: 0` are hard passthrough.
- Because candle body, last-price line, price-axis label, OHLC legend and stats
  all derive from the last close in `_render`, easing the close eases all of
  them — one lever, no render changes.

### Documented caveat

Eased frames are live ticks to the chart: alert predicates and online indicator
recompute see interpolated closes — the linear path between two consecutive real
closes, ≤ `duration` of firing-time skew, distinguishable from truth only by
intrabar knowledge the chart doesn't have. Escape hatches: `duration: 0`,
`detach()`. Compute: ~10–15 renders + `_onlineTick` warm-ups per real tick while
animating — same cost class as `replay.play()`.

### Layout & tests

Mirrors `plugins/replay`: `plugins/animate/animate.mjs` + `tests/*.test.mjs`,
added to `package.json` `test`/`ci` script lists; documented in README +
`plugins.html` with a live playground toggle. Unit tests (jsdom + fake rAF):
wrap/bypass, retarget continuity, wick guard, backfill passthrough, cancel on
setData, reduced-motion passthrough, final frame writes the true bar.

## Open items (decide at implementation)

- Named easings beyond ease-out cubic (`linear`, `ease-out`) — take fn or string.
- Whether `attachAnimate` should also expose `pause()/resume()`.
- Budget commit message convention for the +0.3 KB core bump.
