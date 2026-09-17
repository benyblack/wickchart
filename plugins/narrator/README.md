# wickchart-narrator

[![npm](https://img.shields.io/npm/v/wickchart-narrator)](https://www.npmjs.com/package/wickchart-narrator)

Guided playback for [wickchart](https://github.com/benyblack/wickchart), as an
opt-in plugin — everything that presents the chart as a story: the bar-walk
narrator (a timeline of pivot highs/lows, volume spikes, gaps, RSI
divergences and derived legs), the walk player that replays history while
announcing each event, ear-based sonification for screen-reader-adjacent
use, and story mode (capture chart state as scenes, replay them as a
narrated tour).

```js
npm install wickchart wickchart-narrator

import 'wickchart';
import { attachNarrator } from 'wickchart-narrator';

const chart = document.querySelector('wick-chart');
const narrator = attachNarrator(chart);

chart.narrate();                        // timeline for the whole dataset
chart.narrate({ from, to });            // …or a time window (s or ms)

chart.addEventListener('wick:walk', (e) => showCaption(e.detail));
chart.walk({ from: 0, speed: 120 });    // viewport replay, narrated live
chart.stopWalk();

const story = [
  chart.captureScene('Overview', 'The full picture'),
  { title: 'The breakout', range: { from, to }, indicators: 'sma:20' },
];
chart.playStory(story, { loop: true }); // camera eases scene → scene
chart.stopStory();

narrator.detach();
```

Attaching installs the familiar methods **on the instance**, so code written
against `chart.narrate()` / `walk()` / `playStory()` keeps its shape — one
added import line. Until wickchart 2.0 the core element still ships its own
identical methods; this package shadows them (and carries the home they move
into at the cut — see `ROADMAP-V2.md` in the repo).

## The three players

- **walk** — the viewport slides from `from` to `to` (bar indices, default
  the last ~500) while `wick:walk` events fire per step carrying the
  narrator's events crossed since the last one. Any user input — pointer,
  wheel, keys, double-click — stops it.
- **sonification** — set the `sonify` attribute and every crosshair move
  plays a short sine blip pitched by the bar's close on the visible scale
  (log scales map through log-space). `chart.playRange()` performs a ~4 s
  pitch sweep of the visible bars, riding the crosshair.
- **story** — `captureScene(title?, note?)` snapshots the moment (range,
  type, indicators, overlays, scenario, risk plan); `playStory(scenes, { dwell,
  panMs, loop })` applies each scene, eases the camera to its range, holds,
  and moves on. `wick:story` events narrate every phase.

## API

`attachNarrator(chart)` returns the controller; all methods land on the
chart itself:

| Method | Meaning                                                              |
| ------ | -------------------------------------------------------------------- |
| `narrate(range?)` | the event timeline (`{i, time, type, side, note, legPct?, legBars?}[]`) |
| `walk({ from?, to?, speed?, step? })` | start the narrated viewport replay           |
| `stopWalk()` | stop it (fires a final `stop` phase)                             |
| `playRange()` | ~4 s pitch sweep of the visible bars                               |
| `captureScene(title?, note?)` | snapshot chart state as a scene                    |
| `getStory()` | a copy of the last played story, or `null`                        |
| `playStory(scenes, opts?)` | play a tour — `true` when it started               |
| `stopStory()` | stop it (fires a final `stop` phase)                              |
| `narrator.detach()` | stop playback and restore the element's own methods       |

Events: `wick:walk` (`{ phase: 'step'|'end'|'stop', index, events, from, to }`)
and `wick:story` (`{ phase: 'scene'|'end'|'stop', index, total, scene, title, note }`).

The pure half — `narrateWindow`, `sceneList`/`normalizeScene`,
`easeInOutCubic`, `priceToFreq` — is a separate import with no DOM and no
chart: `import { narrateWindow } from 'wickchart-narrator/core'`. The
analyzer primitives (`detectAnnotations`, `calcRSI`, the overlay/scenario
normalizers) are imported from `wickchart/core`, never duplicated — the
narrator's timeline and the annotations overlay must agree forever.

## Notes

- Audio contexts must be enabled within a user gesture — call `playRange()`
  from a click, not on load.
- This is the one plugin family member that imports `wickchart/core`; from
  a CDN (no bundler) give the browser an import map mapping `wickchart/core`
  to your wickchart copy.
- Camera driving uses the documented element seams (`_view` / `_clampView()`
  / `_invalidate()` / …) listed in `narrator.mjs` — first-party plugins ship
  in lockstep with the element.

MIT.
