// wickchart-paper — pure engine coverage: fill semantics (next-bar opens,
// gap-aware limits), portfolio accounting (cash, netting, flips, averaging),
// mark-to-market equity with peak/drawdown, fees, stats. No DOM, no chart.
import test from 'node:test';
import assert from 'node:assert/strict';

const { PaperModel } = await import('../core.mjs');

const bar = (time, open, high, low, close) => ({ time, open, high, low, close });
/** Monotone bars where o=h=l=c — fills and marks are exact and readable. */
const flat = (time, price) => bar(time, price, price, price, price);

/* ------------------------- market fills ------------------------- */

test('a market order fills at the NEXT bar open — never the seen close', () => {
  const m = new PaperModel({ cash: 10000, time: 0 });
  m.buy(1); // queued while paused at bar 0
  const fills = m.onBar(flat(1000, 100));
  assert.equal(fills.length, 1);
  assert.equal(fills[0].price, 100);
  assert.deepEqual(m.pos, { qty: 1, entry: 100 });
  assert.equal(m.cash, 9900);
  assert.equal(m.orders.length, 0, 'the queued order is consumed');
});

test('long → sell realizes the move; accounting closes to the penny', () => {
  const m = new PaperModel({ cash: 10000 });
  m.buy(1);
  m.onBar(flat(1000, 100)); // long 1 @ 100
  assert.equal(m.equity(110), 10010, 'unrealized mark at 110');
  m.sell(1);
  const fills = m.onBar(flat(2000, 105)); // flat @ 105
  assert.equal(fills.length, 1);
  assert.equal(m.pos, null);
  assert.equal(m.realized, 5);
  assert.equal(m.cash, 10005);
  assert.equal(m.equity(105), 10005);
  assert.deepEqual(m.closed, [{
    side: 1, qty: 1, entry: 100, exit: 105, pnl: 5, fee: 0, at: 2000,
  }]);
});

test('shorts: sell opens, buy back realizes the drop', () => {
  const m = new PaperModel({ cash: 10000 });
  m.sell(1);
  m.onBar(flat(1000, 100)); // short 1 @ 100
  assert.equal(m.equity(90), 10010);
  assert.equal(m.unrealized(90), 10);
  m.buy(1);
  m.onBar(flat(2000, 95));
  assert.equal(m.pos, null);
  assert.equal(m.realized, 5);
  assert.equal(m.equity(95), 10005);
});

test('a sell that exceeds the long closes it and flips short', () => {
  const m = new PaperModel({ cash: 10000 });
  m.buy(2);
  m.onBar(flat(1000, 100)); // long 2 @ 100, cash 9800
  m.sell(5);
  m.onBar(flat(2000, 110)); // close 2 (+20), flip short 3 @ 110, cash +550
  assert.deepEqual(m.pos, { qty: -3, entry: 110 });
  assert.equal(m.realized, 20);
  assert.equal(m.cash, 10350);
  assert.equal(m.equity(110), 10020, 'start + the 20 realized on the close');
  assert.equal(m.closed.length, 1);
  assert.equal(m.closed[0].qty, 2, 'only the closed quantity is a trade');
});

test('adding to a position averages the entry', () => {
  const m = new PaperModel({ cash: 10000 });
  m.buy(1);
  m.onBar(flat(1000, 100));
  m.buy(1);
  m.onBar(flat(2000, 110));
  assert.deepEqual(m.pos, { qty: 2, entry: 105 });
  assert.equal(m.equity(105), 10000, 'flat mark at the average entry');
});

test('flatten queues exactly the closing size', () => {
  const m = new PaperModel({ cash: 10000 });
  m.buy(3);
  m.onBar(flat(1000, 100));
  const o = m.flatten();
  assert.equal(o.side, -1);
  assert.equal(o.qty, 3);
  m.onBar(flat(2000, 100));
  assert.equal(m.pos, null);
  assert.equal(m.flatten(), null, 'nothing to flatten when flat');
});

/* ------------------------- limit fills ------------------------- */

test('a buy limit fills at the limit when the bar trades through it', () => {
  const m = new PaperModel({ cash: 10000 });
  m.buyLimit(95, 1);
  const fills = m.onBar(bar(1000, 98, 99, 94, 97));
  assert.equal(fills.length, 1);
  assert.equal(fills[0].price, 95, 'filled at the limit, not the open');
  assert.deepEqual(m.pos, { qty: 1, entry: 95 });
});

test('a gap through the limit fills at the open — the better price', () => {
  const m = new PaperModel({ cash: 10000 });
  m.buyLimit(95, 1);
  const fills = m.onBar(bar(1000, 92, 96, 91, 95));
  assert.equal(fills[0].price, 92, 'bought at the gapped-open, never worse');
});

test('a sell limit fills at/above the limit; untouched orders keep working', () => {
  const m = new PaperModel({ cash: 10000 });
  m.sellLimit(120, 1);
  assert.equal(m.onBar(bar(1000, 112, 118, 110, 115)).length, 0, 'not touched');
  assert.equal(m.orders.length, 1, 'still working');
  const fills = m.onBar(bar(2000, 116, 125, 115, 122));
  assert.equal(fills.length, 1);
  assert.equal(fills[0].price, 120);
  assert.deepEqual(m.pos, { qty: -1, entry: 120 });
});

test('cancel removes a working order; junk orders are refused', () => {
  const m = new PaperModel({ cash: 10000 });
  const o = m.buyLimit(95, 1);
  assert.equal(m.buyLimit(-3, 1), null);
  assert.equal(m.buy(0), null);
  assert.equal(m.cancel(o.id), true);
  assert.equal(m.cancel(o.id), false);
  assert.equal(m.orders.length, 0);
  m.onBar(bar(1000, 90, 99, 89, 95));
  assert.equal(m.pos, null, 'a cancelled order never fills');
});

/* ------------------------- fees ------------------------- */

test('fees come off cash per fill and ride the closed trade', () => {
  const m = new PaperModel({ cash: 10000, fee: 0.001 });
  m.buy(1);
  m.onBar(flat(1000, 100)); // fee 0.10 → cash 9899.9
  m.sell(1);
  m.onBar(flat(2000, 105)); // fee 0.105 → realized 5 − 0.105
  assert.ok(Math.abs(m.cash - 10004.795) < 1e-9);
  assert.ok(Math.abs(m.realized - 4.895) < 1e-9);
  assert.ok(Math.abs(m.closed[0].pnl - 4.895) < 1e-9);
});

/* ------------------------- equity + stats ------------------------- */

test('the equity series marks every bar close and tracks peak drawdown', () => {
  const m = new PaperModel({ cash: 10000 });
  m.buy(1);
  m.onBar(flat(1000, 100)); // filled at the open, marked at the close → 10000
  m.onBar(flat(2000, 120)); // +20 → 10020 (peak)
  m.onBar(flat(3000, 90)); // −10 → 9990 (dd from peak)
  m.onBar(flat(4000, 80)); // −20 → 9980
  assert.deepEqual(
    m.series.map((p) => p.equity),
    [10000, 10020, 9990, 9980]
  );
  assert.ok(Math.abs(m.maxDD - 40 / 10020) < 1e-9, 'peak-to-trough fraction');
  const s = m.stats();
  assert.equal(s.trades, 0);
  assert.equal(s.winRate, null);
  assert.deepEqual(s.position, { qty: 1, entry: 100 });
});

test('stats count wins and losses; reset restores the account', () => {
  const m = new PaperModel({ cash: 5000 });
  m.buy(1);
  m.onBar(flat(1000, 100));
  m.sell(1);
  m.onBar(flat(2000, 110)); // win +10
  m.buy(1);
  m.onBar(flat(3000, 110));
  m.sell(1);
  m.onBar(flat(4000, 105)); // loss −5
  const s = m.stats();
  assert.equal(s.trades, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.realized, 5);
  m.reset(9000);
  assert.equal(m.cash, 5000);
  assert.equal(m.pos, null);
  assert.equal(m.series.length, 1, 'reset seeds a fresh equity point');
  assert.deepEqual(m.series[0], { time: 9000, equity: 5000 });
});

test('onBar tolerates junk bars without advancing the tape', () => {
  const m = new PaperModel({ cash: 10000, time: 0 });
  m.buy(1);
  assert.deepEqual(m.onBar(null), []);
  assert.deepEqual(m.onBar({ time: 5 }), []);
  assert.equal(m.series.length, 1);
  assert.equal(m.orders.length, 1, 'queued order survives a junk bar');
});

test('defaults: 10k account, no fee, positive-cash validation', () => {
  const m = new PaperModel({ cash: -5, fee: 99 });
  assert.equal(m.startCash, 10000, 'non-positive cash falls back');
  assert.equal(m.fee, 0, 'out-of-range fee refused');
});
