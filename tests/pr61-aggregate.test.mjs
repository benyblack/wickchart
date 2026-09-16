// PR #61 — information-based bar aggregation ("advanced bars"): tick /
// volume / dollar bars built client-side from a trade stream. Pure-function
// coverage for the aggregator, the spec parser, the batch helper, the
// synthetic tape generators and the Binance aggTrades endpoints (fetch
// mocked at the transport, same idiom as the socket test in pr56).
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  parseAggregate,
  TickBarAggregator,
  aggregateTrades,
  normalizeTrades,
  genSyntheticTrades,
  makeSynthTradeStream,
  synthTradesPerBar,
  fetchBinanceAggTrades,
  fetchBinanceAggTradesSince,
  openBinanceTradeSocket,
} = await import('../src/feeds.js');

const trade = (time, price, size) => ({ time, price, size });

/* ----------------------------- spec parsing ----------------------------- */

test('parseAggregate accepts explicit, defaulted and padded specs', () => {
  assert.deepEqual(parseAggregate('tick:200'), { kind: 'tick', threshold: 200 });
  assert.deepEqual(parseAggregate(' VOLUME : 12.5 '), { kind: 'volume', threshold: 12.5 });
  assert.deepEqual(parseAggregate('dollar'), { kind: 'dollar', threshold: 25000 });
  assert.deepEqual(parseAggregate('tick'), { kind: 'tick', threshold: 100 });
});

test('parseAggregate rejects garbage instead of guessing', () => {
  for (const bad of [null, '', 'time', 'ticks:10', 'volume:0', 'dollar:-5', 'volume:abc', 'tick:1e9x']) {
    assert.equal(parseAggregate(bad), null, `${JSON.stringify(bad)} should not parse`);
  }
});

/* ------------------------------ tick bars ------------------------------- */

test('tick bars close on trade count and carry true OHLCV', () => {
  const t0 = 1e12; // ms-scale, so the seconds heuristic stays out of the way
  const agg = new TickBarAggregator('tick', 3);
  assert.equal(agg.add(trade(t0, 10, 1)), null);
  assert.equal(agg.add(trade(t0 + 1, 12, 2)), null);
  const bar = agg.add(trade(t0 + 2, 11, 3));
  assert.deepEqual(bar, {
    time: t0, open: 10, high: 12, low: 10, close: 11, volume: 6, closed: true,
  });
  // the next group starts fresh from the next print
  assert.equal(agg.current(), null);
  assert.deepEqual(agg.add(trade(t0 + 3, 9, 1)), null);
  assert.deepEqual(agg.current(), { time: t0 + 3, open: 9, high: 9, low: 9, close: 9, volume: 1 });
});

test('a print with zero size still counts toward a tick bar', () => {
  const agg = new TickBarAggregator('tick', 2);
  assert.equal(agg.add(trade(1000, 5, 0)), null);
  const bar = agg.add(trade(2000, 5, 0));
  assert.equal(bar.volume, 0, 'no size, no volume — but the print counted');
  assert.equal(bar.closed, true);
});

/* ---------------------------- volume/dollar ----------------------------- */

test('volume bars close when base units cross the threshold', () => {
  const agg = new TickBarAggregator('volume', 10);
  assert.equal(agg.add(trade(1000, 100, 4)), null);
  assert.equal(agg.add(trade(2000, 101, 4)), null);
  const bar = agg.add(trade(3000, 99, 4)); // 12 ≥ 10 — closes on the overshoot
  assert.equal(bar.volume, 12);
  assert.equal(bar.closed, true);
});

test('dollar bars accumulate price×size notional, not trade count', () => {
  const agg = new TickBarAggregator('dollar', 1000);
  assert.equal(agg.add(trade(1000, 100, 3)), null); // $300
  assert.equal(agg.add(trade(2000, 110, 3)), null); // $330 → $630
  const bar = agg.add(trade(3000, 105, 4)); // $420 → $1050 ≥ $1000
  assert.equal(bar.closed, true);
  assert.equal(bar.volume, 10);
  assert.equal(bar.open, 100);
  assert.equal(bar.close, 105);
});

test('a whale print is never split across two bars', () => {
  const agg = new TickBarAggregator('volume', 5);
  const whale = agg.add(trade(1000, 50, 1000)); // 200× the threshold, one bar
  assert.equal(whale.closed, true);
  assert.equal(whale.volume, 1000);
  assert.equal(agg.current(), null, 'nothing spills into a fabricated next bar');
});

/* ------------------------- robustness + flush ---------------------------- */

test('seconds are upgraded to ms; bad prints are ignored, not thrown', () => {
  const agg = new TickBarAggregator('tick', 2);
  assert.equal(agg.add({ price: 10, size: 1, time: 1726000000 }), null); // seconds
  const bar = agg.add({ price: 10, size: 1, time: 1726000001 });
  assert.ok(bar.time >= 1e12, 'bar time is in milliseconds');
  assert.equal(agg.add(null), null);
  assert.equal(agg.add({ price: -3, size: 1, time: 5 }), null);
  assert.equal(agg.add({ price: NaN, size: 1, time: 5 }), null);
  assert.equal(agg.add(undefined), null);
  assert.deepEqual(agg.current(), null, 'nothing formed from invalid prints');
});

test('invalid constructor arguments fall back to sane defaults', () => {
  assert.deepEqual(
    [new TickBarAggregator('nope', -5).kind, new TickBarAggregator('nope', -5).threshold],
    ['tick', 100]
  );
  assert.equal(new TickBarAggregator('volume', 'x').threshold, 10);
});

test('flush closes the forming bar as-is', () => {
  const agg = new TickBarAggregator('tick', 100);
  agg.add(trade(1000, 7, 1));
  agg.add(trade(1100, 8, 1));
  const bar = agg.flush();
  assert.equal(bar.closed, true);
  assert.equal(bar.volume, 2);
  assert.equal(agg.flush(), null, 'second flush has nothing to close');
});

/* --------------------------- batch aggregation --------------------------- */

test('aggregateTrades returns closed bars, the pending remainder and a live aggregator', () => {
  const t0 = 1e12;
  const trades = [];
  for (let i = 0; i < 10; i++) trades.push(trade(t0 + i, 10 + i, 1));
  const res = aggregateTrades(trades, 'tick', 4);
  assert.equal(res.bars.length, 2);
  // trades 9–10 form the pending bar (indices 8–9, prices 18–19)
  assert.deepEqual(res.pending, { time: t0 + 8, open: 18, high: 19, low: 18, close: 19, volume: 2 });
  // streaming continues through the same aggregator: no seam, no re-count
  assert.equal(res.aggregator.add(trade(t0 + 99, 25, 1)), null);
  assert.equal(res.aggregator.current().close, 25);
});

test('aggregateTrades tolerates non-array input', () => {
  assert.deepEqual(aggregateTrades(null, 'tick', 5).bars, []);
});

/* ------------------------------ normalizer ------------------------------- */

test('normalizeTrades maps aliases, upgrades seconds, drops junk, sorts by time', () => {
  const out = normalizeTrades([
    { t: 2000, price: 11, qty: 2 },                    // seconds + t/qty aliases
    { time: 1726000005000, price: 10, size: 1 },       // ms passes through
    { time: 1500, price: 0, size: 1 },                 // bad price
    { time: 1500, price: 12 },                         // missing size
    'nope',
    null,
    { time: 1726000000, price: 12, amount: 3 },        // seconds + amount alias
  ]);
  assert.deepEqual(out, [
    { time: 2000000, price: 11, size: 2 },            // 1970 sorts first
    { time: 1726000000000, price: 12, size: 3 },
    { time: 1726000005000, price: 10, size: 1 },
  ]);
  assert.deepEqual(normalizeTrades(undefined), []);
});

/* --------------------------- synthetic tape ------------------------------ */

test('genSyntheticTrades is deterministic per key and well-formed', () => {
  const a = genSyntheticTrades('BTC', 500, 64250);
  const b = genSyntheticTrades('BTC', 500, 64250);
  assert.deepEqual(a, b, 'same key → same tape');
  assert.equal(a.length, 500);
  for (let i = 1; i < a.length; i++) {
    assert.ok(a[i].time > a[i - 1].time, 'times strictly increase');
    assert.ok(a[i].price > 0 && a[i].size > 0);
  }
});

test('the synthetic tape sizes produce sensible bars per threshold', () => {
  // mean notional ≈ $2,020 and sizes are notional/price — the seed sizer
  // relies on both, so pin the relationship end to end on a real batch
  const base = 64250;
  const trades = genSyntheticTrades('BTC', 8000, base);
  const { bars } = aggregateTrades(trades, 'dollar', 20200); // ~10 prints/bar
  assert.ok(bars.length > 700 && bars.length < 900, `expected ~800 bars, got ${bars.length}`);
  for (const bar of bars) {
    assert.ok(bar.high >= Math.max(bar.open, bar.close));
    assert.ok(bar.low <= Math.min(bar.open, bar.close));
    assert.ok(bar.volume > 0);
  }
  // the sizer agrees with reality for both value kinds (±20% — the walk
  // drifts a few percent off `base` over 8000 prints, and the sizer only
  // needs to be close enough to size a seed)
  const perDollar = synthTradesPerBar({ kind: 'dollar', threshold: 20200 }, base);
  assert.ok(Math.abs(perDollar - trades.length / bars.length) / perDollar < 0.2, 'dollar estimate is close');
  const { bars: volBars } = aggregateTrades(trades, 'volume', 6.3); // ≈ $2,020×6.3/base
  const perVolume = synthTradesPerBar({ kind: 'volume', threshold: 6.3 }, base);
  assert.ok(
    Math.abs(perVolume - trades.length / volBars.length) / perVolume < 0.2,
    'volume estimate is close'
  );
});

test('makeSynthTradeStream bridges from the last price and never rewinds time', () => {
  const next = makeSynthTradeStream(64250);
  let t = 0;
  let price;
  for (let i = 0; i < 200; i++) {
    const p = next();
    assert.ok(p.time > t, 'stream times strictly increase');
    assert.ok(p.price > 0 && p.size > 0);
    t = p.time;
    price = p.price;
  }
  assert.ok(price > 100 && price < 1e7, 'stays in a sane range around the start');
});

/* -------------------------- Binance aggTrades ---------------------------- */

/** Build a mock fetch over an in-memory tape of {a, T, p, q} rows. */
function mockBinance(pages) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const rows = pages.shift() || [];
    return { ok: true, json: async () => rows };
  };
  return calls;
}

test('fetchBinanceAggTrades pages backwards from the newest prints', async () => {
  const page = (a0) => Array.from({ length: 1000 }, (_, i) => ({ a: a0 + i, T: a0 + i, p: '100', q: '1' }));
  const calls = mockBinance([page(9000), page(8000), page(7000)]);
  try {
    const { trades, oldestId } = await fetchBinanceAggTrades('BTCUSDT', 2500, 3);
    // first call: no fromId → newest page; then one below, one below that
    assert.ok(!calls[0].includes('fromId'));
    assert.ok(calls[1].includes('fromId=8000'));
    assert.ok(calls[2].includes('fromId=7000'));
    assert.equal(trades.length, 3000);
    assert.equal(oldestId, 7000);
    assert.ok(trades[0].time <= trades[trades.length - 1].time, 'ascending');
    assert.deepEqual(trades[0], { id: 7000, time: 7000, price: 100, size: 1 });
  } finally {
    delete globalThis.fetch;
  }
});

test('fetchBinanceAggTrades honors beforeId and filters window overlap', async () => {
  const page = (a0) => Array.from({ length: 1000 }, (_, i) => ({ a: a0 + i, T: a0 + i, p: '1', q: '1' }));
  const calls = mockBinance([page(500)]); // window [500,1500) — only ids < 1000 wanted
  try {
    const { trades, oldestId } = await fetchBinanceAggTrades('BTCUSDT', 1000, 2, 1000);
    assert.ok(calls[0].includes('fromId=0'));
    assert.ok(trades.every((t) => t.id < 1000), 'no overlap with prints already held');
    assert.equal(trades.length, 500);
    assert.equal(oldestId, 500);
  } finally {
    delete globalThis.fetch;
  }
});

test('fetchBinanceAggTrades stops at a short page (start of tape)', async () => {
  const calls = mockBinance([[{ a: 3, T: 3, p: '1', q: '1' }, { a: 4, T: 4, p: '1', q: '1' }]]);
  try {
    const { trades } = await fetchBinanceAggTrades('BTCUSDT', 5000, 5);
    assert.equal(trades.length, 2);
    assert.equal(calls.length, 1, 'a short page ends the walk');
  } finally {
    delete globalThis.fetch;
  }
});

test('fetchBinanceAggTrades propagates HTTP failures', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 451 });
  try {
    await assert.rejects(() => fetchBinanceAggTrades('BTCUSDT'), /451/);
  } finally {
    delete globalThis.fetch;
  }
});

test('fetchBinanceAggTradesSince returns one forward window', async () => {
  const calls = mockBinance([[{ a: 101, T: 10, p: '5', q: '2' }, { a: 102, T: 11, p: '6', q: '2' }]]);
  try {
    const { trades, latestId } = await fetchBinanceAggTradesSince('BTCUSDT', 101);
    assert.ok(calls[0].includes('fromId=101'));
    assert.equal(trades.length, 2);
    assert.equal(latestId, 102);
    assert.deepEqual(trades[0], { id: 101, time: 10, price: 5, size: 2 });
  } finally {
    delete globalThis.fetch;
  }
});

/* --------------------------- trade WebSocket ----------------------------- */

test('the aggTrade socket parses prints and skips other frames', async () => {
  const sockets = [];
  globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); }
    close() {}
  };
  globalThis.WebSocket.OPEN = 1;
  const trades = [];
  try {
    const handle = openBinanceTradeSocket('BTCUSDT', (t) => trades.push(t), () => {});
    const ws = sockets[0];
    assert.ok(ws.url.endsWith('btcusdt@aggTrade'));
    ws.onmessage({ data: JSON.stringify({ e: 'aggTrade', a: 7, T: 99, p: '42.5', q: '0.3' }) });
    ws.onmessage({ data: JSON.stringify({ e: 'kline', k: {} }) }); // wrong frame
    ws.onmessage({ data: '{bad json' });
    handle.close();
  } finally {
    delete globalThis.WebSocket;
  }
  assert.deepEqual(trades, [{ id: 7, time: 99, price: 42.5, size: 0.3 }]);
});
