# wickchart-coview

[![npm](https://img.shields.io/npm/v/wickchart-coview)](https://www.npmjs.com/package/wickchart-coview)

Cross-tab co-view for [wickchart](https://github.com/benyblack/wickchart), as
an opt-in plugin — charts that share a room name keep each other briefed.
Every pan/zoom broadcasts the visible window (throttled to ~8/s, heartbeat
every 4 s), each chart renders the others' viewports as labeled bands along
the top of the plot, and the crosshair is shared live — a dashed ghost
mirrors the pointer of the tab you are pairing with. Closed tabs say
goodbye; crashed tabs fade via the 12 s presence TTL. Zero dependencies.

```js
npm install wickchart wickchart-coview

import 'wickchart';
import { attachCoview } from 'wickchart-coview';

// declarative — the room is the attribute:
// <wick-chart co-view="btc-warroom" co-view-name="Maya"></wick-chart>
const coview = attachCoview(chart);

chart.getPeers();
// [{ id, name: 'Maya', range: { from, to }, at }] — oldest sighting first

chart.addEventListener('wick:peers', (e) => {
  // { peers, joined, left } — membership changes only, not every move
});

coview.detach();
```

Until wickchart 2.0 the core element ships its own identical machinery;
attaching shadows it with the same behavior (this package is the home it
moves into at the cut — see `ROADMAP-V2.md` in the repo).

## The protocol

Public and tiny — anything that can `postMessage` can join a room:
channel `wick-co-view:<room>`, messages `{ v: 1, peer, … }` where `peer` is
a random per-chart id:

| type | payload | meaning |
| ---- | ------- | ------- |
| `view` | `from`, `to`, `name` | the sender's visible window (presence heartbeat) |
| `cross` | `time`, `yFrac` — or `time: null` | pointer moved / left |
| `bye` | — | sender is leaving the room |

Wrong-version, self-echoed, and unknown messages are ignored — the envelope
check lives in `coUnwrap()` and is safe by construction.

## API

`attachCoview(chart, { channel?, ttl?, beatMs? })` returns the controller:

| Method | Meaning                                                     |
| ------ | ----------------------------------------------------------- |
| `chart.getPeers()` | live peers with their viewports, oldest first  |
| `coview.detach()` | goodbye, close, restore the element's own machinery |

`channel` is an injectable transport factory (tests, WebSocket bridges);
`ttl` is the presence timeout (default 12 s); `beatMs` the heartbeat
(default 4 s). Events on the chart: `wick:peers` with
`{ peers, joined, left }`.

The pure half — `PresenceTracker` (TTL bookkeeping) and the protocol
envelope (`coWrap`/`coUnwrap`) — is a separate import with no DOM:
`import { PresenceTracker } from 'wickchart-coview/core'`.

MIT.
