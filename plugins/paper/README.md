# wickchart-paper

[![npm](https://img.shields.io/npm/v/wickchart-paper)](https://www.npmjs.com/package/wickchart-paper)

Paper trading for [wickchart](https://github.com/benyblack/wickchart), as an
opt-in plugin — place orders while
[wickchart-replay](https://github.com/benyblack/wickchart/tree/main/plugins/replay)
plays the tape forward, watch them fill at honest prices, and see the
session's equity curve docked under the chart. Zero dependencies, zero core
changes: the engine is plain data in / data out, driven from the chart's
public `wick:replay` events and rendered through the layer API.

```js
npm install wickchart wickchart-replay wickchart-paper

import 'wickchart';
import { attachReplay } from 'wickchart-replay';
import { attachPaper } from 'wickchart-paper';

const chart = document.querySelector('wick-chart');
const replay = attachReplay(chart);
const paper = attachPaper(chart, { cash: 10000, fee: 0.0004 });

replay.start();          // ~70% into the data, future hidden
paper.buy(1);            // queued — fills at the NEXT bar's open
paper.buyLimit(95, 1);   // working until a bar trades through it
paper.flatten();         // market-close the whole position
replay.play(8);          // watch the fills and the equity curve

paper.stats;             // equity, realized, trades, winRate, maxDD, series
paper.detach();
```

The open position mirrors onto the core positions API (`addPosition`) — an
entry line with a live P&L readout on the price chart itself. Fills draw as
dots on the equity curve.

## The honesty contract

- An order placed while paused at bar N fills during bar N+1 — **you can
  never trade a close you have already seen**.
- Market orders fill at the next bar's **open**.
- Limit orders fill at the limit, or at the open when the open **gaps
  through** it — the better price for the taker, never worse.
- Equity is marked at each bar's close: `cash + qty × close`; peak and max
  drawdown are tracked off that series.
- Seeking the replay backwards (or looping) **resets the session** — equity
  restarts from the new anchor.

## Accounting

Signed quantities net and flip (sell 5 against a long of 2 closes it and
opens a short of 3; the flip's fee splits proportionally between the closed
trade and the new position). Adds average the entry. Fees (`fee` — a
fraction of fill notional, e.g. `0.0004` = 4 bps) come off cash per fill.

## API

`attachPaper(chart, { cash = 10000, fee = 0, dock = 44 })` returns the
controller:

| Method | Meaning                                                        |
| ------ | -------------------------------------------------------------- |
| `buy(qty)` / `sell(qty)` | queue a market order (fills next open)          |
| `buyLimit(price, qty)` / `sellLimit(price, qty)` | working limit orders |
| `cancel(id)` | remove a working order                                      |
| `flatten()` | queue a market order that exactly closes the position        |
| `reset(time?)` | restore the starting account                               |
| `stats` | `{ cash, position, realized, trades, wins, winRate, maxDD, series, … }` |
| `detach()` | unsync and remove the strip                                 |

Events on the chart (`wick:paper`): `order`, `fill`, `close`, `cancel`,
`reset` — the detail carries the affected object plus the live position,
realized P&L and equity.

The pure engine (`PaperModel`) is a separate import with no DOM and no
chart: `import { PaperModel } from 'wickchart-paper/core'` — useful for
backtesting strategies directly against arrays of bars.

MIT.
