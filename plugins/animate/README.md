# wickchart-animate

[![npm](https://img.shields.io/npm/v/wickchart-animate)](https://www.npmjs.com/package/wickchart-animate)

Live-price easing for [wickchart](https://github.com/benyblack/wickchart), as
an opt-in plugin — the core stays animation-free. Zero dependencies, zero
core changes: the whole engine wraps `chart.update()` on the instance, so
every tick source — app code, `<wick-feed>`, the paper plugin — is eased
without wiring.

Ticks on the forming bar glide to their new close over a short ease instead
of teleporting. It is display-path only: no drawing, no new core surface.
Attach once per chart. ~2.3 KB gz, under its own CI budget.

```js
npm install wickchart wickchart-animate   // the plugin is a separate package

import 'wickchart';                        // the chart itself
import { attachAnimate } from 'wickchart-animate';

const chart = document.querySelector('wick-chart');
const anim = attachAnimate(chart);         // duration defaults to 180 ms
// opts: { duration: 180, easing: 'ease-out' | 'linear' | fn(t), volume: false }
anim.detach();                             // flush the true bar, restore update()
```

- **opts**: `duration` (ms, default 180, 0 disables, clamped at 1500),
  `easing` (`'ease-out'` | `'linear'` | a `fn(t)`), `volume` (ease volume
  too; default `false`).
- **The final frame always writes the true bar** — the eased frames are
  interpolated closes (high/low clamped so the body never escapes its
  wick), and the ease always lands on the exact tick.
- **A new bar flushes** the previous bar's true value first, then appends;
  **backfills / historical corrections pass through un-eased** while an
  active ease keeps running; **a second tick mid-ease retargets from the
  displayed value** — closes stay monotonic, never jumping back to a stale
  data read.
- **prefers-reduced-motion is a hard passthrough** — no easing, no frames.
- **Caveat**: eased frames are live ticks to the chart, so alert predicates
  and online indicator recompute see interpolated closes — the linear path
  between two real closes, at most `duration` of firing-time skew.

Peer dependency: wickchart ≥ 2.3.0.
