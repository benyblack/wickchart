# wickchart-grid

[![npm](https://img.shields.io/npm/v/wickchart-grid)](https://www.npmjs.com/package/wickchart-grid)

Multi-chart layout + sync for [wickchart](https://github.com/benyblack/wickchart),
as an opt-in plugin — one element wraps N charts in a CSS grid and keeps
their visible ranges and crosshairs in step. Zero dependencies, zero core
changes: everything rides the chart's public `wick:range` / `wick:crosshair`
events, `setVisibleRange()` and layer API, and detaches cleanly.

```html
<script type="module" src="https://unpkg.com/wickchart-grid"></script>

<wick-grid cols="2" gap="10" sync="range crosshair" style="height: 640px">
  <wick-chart label="BTC · 1h" indicators="sma:20 volume"></wick-chart>
  <wick-chart label="BTC · 15m" indicators="rsi:14"></wick-chart>
  <wick-chart label="ETH · 1h" type="line"></wick-chart>
  <wick-chart label="BTC · dollar bars" indicators="volume"></wick-chart>
</wick-grid>
```

Pan or zoom any chart and the others follow; hover one and a dashed ghost
crosshair mirrors onto the rest. The host needs a height (grid rows size
from it) — a fixed `height`, or a flex/grid parent.

## Attributes

| Attribute | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| `cols`    | column count (default 2, clamped 1..8); rows flow automatically      |
| `gap`     | cell gap in px (default 10, clamped 0..64)                           |
| `sync`    | space/comma list of `range` `crosshair` `time` `both`, or `off`/`none` (default `range crosshair`) |

`crosshair` mirrors time **and** price lines; `time` mirrors the vertical
line only — the right choice when the charts' price scales are not
comparable (different symbols). `range` shares the visible window.

## Programmatic

```js
import { attachGrid } from 'wickchart-grid';

const grid = attachGrid([a, b, c], { sync: 'range time' });
grid.charts;     // the registered charts
grid.detach();   // unsync everything (ghost layers removed)
```

The pure fan-out model — echo suppression, clamp-cycle breaking, the ghost
crosshair layer — is a separate import with no DOM at all:
`import { GridSync, parseSync, makeGhost } from 'wickchart-grid/core'`.
Charts are duck-typed: anything that fires `wick:range` / `wick:crosshair`
and exposes `setVisibleRange` can join a group.

## How the feedback loops are handled

- Applying a range to a sibling makes that sibling emit its own `wick:range`
  — the group swallows the echo it just caused (per-chart expected range).
- A sibling whose data cannot display the target range clamps it, and the
  clamped echo would re-fan-out; the same target arriving back within 250 ms
  is recognized as a clamp cycle and dropped, so two sparse charts converge
  instead of ping-ponging.
- The ghost crosshair is a plain layer drawing dashed lines at the last
  synced position — it fires no events, so it cannot loop.

MIT.
