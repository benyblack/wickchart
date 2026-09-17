# wickchart-scenario

[![npm](https://img.shields.io/npm/v/wickchart-scenario)](https://www.npmjs.com/package/wickchart-scenario)

Scenario planning for [wickchart](https://github.com/benyblack/wickchart),
as an opt-in plugin — two planning surfaces drawn straight onto the chart:

- **Scenario projection** — a ghost path of future prices plus optional
  σ-bands (a volatility cone widening with √h from realized volatility).
  Setting a scenario reserves future space on the right so the projection
  stays visible.
- **Risk plan** — an R-multiple grid anchored at entry/stop. 1R =
  |entry − stop|; reward lines are drawn at kR beyond the entry with
  risk/reward zones shaded, so sizing and take-profit choices read directly
  off the chart.

```js
npm install wickchart wickchart-scenario

import 'wickchart';
import { attachScenario } from 'wickchart-scenario';

const scenario = attachScenario(chart);

chart.setScenario({ path: [64000, 65500, 68000], label: 'bull case' });
chart.setScenario({ horizon: 48 });          // cone-only projection
chart.setScenario({ horizon: 24, cone: false }); // path/labels only
chart.scenario;                              // a copy of the active one
chart.clearScenario();

chart.setRiskPlan({ entry: 64500, stop: 63800, multiples: [1, 2, 3] });
chart.setRiskPlan({ entry: 64500, stop: 63800, targets: [65900, 67300] });
chart.riskPlan;   // { entry, stop, risk, direction, levels: [{k, price}], … }
chart.clearRiskPlan();

scenario.detach();
```

Attaching installs the familiar methods **on the instance**, so existing
call sites keep their shape. Until wickchart 2.0 the core element ships
its own identical methods; attaching shadows them (this package is the
home they move into at the cut — see `ROADMAP-V2.md` in the repo).

## Semantics

- Invalid specs are dropped, never thrown — and **clear** what was there
  before (replace semantics, same as `setOverlays`).
- Scenario: `path` is future bars 1..N (plain prices or `{price}` objects,
  junk dropped, capped at 250); `horizon` 1–500 defaults to the path
  length; `levels` are σ multipliers (default `[1, 2]`, each ≤ 5); `color`
  accepts `up`/`down`/`accent` or safe CSS colors.
- Risk plan: direction is derived (stop below entry ⇒ long); explicit
  `targets` convert to their signed R multiple, wrong-side prices drop;
  `multiples` win when both are given; at most 8 levels, each ≤ 20R.
- Both are analysis data, excluded from `getState()`/`setState()` — they
  are app state, not chart state.

## API

`attachScenario(chart)` returns the controller; the methods land on the
chart itself:

| Method | Meaning                                                  |
| ------ | -------------------------------------------------------- |
| `chart.setScenario(spec)` | project a path + cone; returns the normalized spec or `null` |
| `chart.clearScenario()` | remove the projection                      |
| `chart.scenario` | a copy of the active scenario (or `null`)             |
| `chart.setRiskPlan(spec)` | lay out the R-multiple grid; same return contract |
| `chart.clearRiskPlan()` | remove the plan                             |
| `chart.riskPlan` | a copy of the active plan (or `null`)                 |
| `scenario.detach()` | restore the element's own methods                     |

The pure surface (validators, the √h cone math, realized volatility) is a
separate import: `wickchart-scenario/core`. During 1.x it re-exports the
functions from `wickchart/core` unchanged — they are shared (the scene
validator in wickchart-narrator imports the same normalizers) — and they
settle into this package at the 2.0 cut.

MIT.
