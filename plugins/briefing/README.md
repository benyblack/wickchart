# wickchart-briefing

[![npm](https://img.shields.io/npm/v/wickchart-briefing)](https://www.npmjs.com/package/wickchart-briefing)

One command that explains the chart, for [wickchart](https://github.com/benyblack/wickchart) —
the visible window synthesized into a structured **markdown briefing**:
tape summary, candlestick signal census, smart annotations and the narrate
timeline, composed into one ready-to-paste document. Computed locally;
nothing leaves the page until you copy it somewhere.

Pure composition, no re-derivation: the tape *is* `windowSummary` from
`wickchart/core`, the census *is* `detectSignals` from
[`wickchart-signals`](https://www.npmjs.com/package/wickchart-signals),
the annotations and timeline *are* `detectAnnotations` and `narrateWindow`
(the analyzer behind [`wickchart-narrator`](https://www.npmjs.com/package/wickchart-narrator)).
The briefing can never disagree with the chart it describes. ~3.4 KB gz
under its own CI budget, on top of those two packages.

```js
npm install wickchart wickchart-briefing

import 'wickchart';
import { attachBriefing } from 'wickchart-briefing';

attachBriefing(chart);
const b = chart.briefing();      // the model — null before data lands
b.markdown;                      // the document (also structured fields)
await chart.copyBriefing();      // …straight to the clipboard
```

The document:

```markdown
# BTC · 1h — chart briefing

_2026-09-30 14:00 → 2026-10-07 08:00 · 300 bars · 1h · generated 2026-10-07 12:00_

## Tape
- Close 64,012 (+12.34% over window). High 65,432 on 10-05, low 58,120 on 10-02. Max drawdown 8.1%.
- Trend: strong uptrend (drift +0.212%/bar, fit r² 0.81). Price above SMA20 (63,100). RSI(14) 61.3.
- Volatility: annualized 41%; latest realized vol at the 78th percentile of the window (hot regime).
- Bars: 163 up / 137 down. Volume avg 1.2k/bar, peak 15k on 10-03.
- Notable: 3.4× volume spike (10-03); gap +0.8% (10-05); …

## Signals
18 candlestick signals in the window: 6 bullish engulfing, 4 bearish pin bar, …
- latest: bearish engulfing — 2026-10-06 14:00

## Annotations
- 2026-10-06 14:00 — pivot high
- 2026-10-03 09:00 — volume spike 3.4× median
…

## Timeline
- 2026-10-02 04:00 — pivot low
- 2026-10-06 14:00 — pivot high (→ +12.4% over 98 bars)
…

---
_Computed locally by wickchart-briefing · nothing left the page_
```

- **`chart.briefing()`** covers the *visible range* (falling back to the
  full dataset) and returns `{ title, generatedAt, window, summary,
  signals, annotations, timeline, markdown }`; `null` before data lands.
- **`chart.copyBriefing()`** writes the markdown to the clipboard and
  resolves the model.
- **opts** (on attach or per call): `label`, `kinds` (signal subset),
  `maxEvents` (annotation cap, default 8), and the timeline's `pivot` /
  `volMult` / `gapMult` knobs — passed through to `narrateWindow`.
- **Deterministic output**: timestamps render UTC-stable
  (`YYYY-MM-DD HH:MM`), and `now` can be injected — the same window
  briefs byte-identically, which the tests pin.
- **`briefingModel(bars, i0, i1, opts)`** from `wickchart-briefing/core`
  is the pure half — no chart, no DOM, usable from a worker or a backtest.

Dependencies: `wickchart-signals`, `wickchart-narrator`. Peer dependency:
wickchart ≥ 1.4.0.
