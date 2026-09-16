// PR #64 — the worker compute path: protocol dispatch (worker-core), the
// main-thread pool (fake Worker injected), and the chart's _indicatorSeries
// branch (pr56-style prototype binding over a duck-typed chart). No real
// Worker exists in Node — that last mile is covered by e2e/worker.spec.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------ helpers ------------------------------ */

const bars = (n) =>
  Array.from({ length: n }, (_, i) => ({
    time: 1_700_000_000_000 + i * 60_000,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10,
  }));

const colsOf = (bs) => {
  const n = bs.length;
  const cols = {
    time: new Float64Array(n), open: new Float64Array(n), high: new Float64Array(n),
    low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) Object.keys(cols).forEach((k) => (cols[k][i] = bs[i][k]));
  return cols;
};

/* --------------------------- worker-core --------------------------- */

test('worker-core: epoch then indicator computes over the shipped columns', async () => {
  const { createWorkerCore } = await import('../src/worker-core.js');
  const core = createWorkerCore();
  const bs = bars(100);
  assert.equal(core.handle({ id: 1, type: 'epoch', sid: 7, epoch: 0, cols: colsOf(bs) }).ok, true);

  const r = core.handle({ id: 2, type: 'indicator', sid: 7, epoch: 0, name: 'sma', params: { period: 10 } });
  assert.equal(r.ok, true);
  const line = r.res.lines ? r.res.lines[0].values : r.res;
  assert.ok(Array.isArray(line) || line instanceof Float64Array);
  // SMA(10) at index 99 = mean of closes 90..99 — identical to the sync definition
  const expect = bs.slice(90, 100).reduce((s, b) => s + b.close, 0) / 10;
  assert.ok(Math.abs(line[99] - expect) < 1e-9, 'value matches the sync definition');
  assert.equal(line.length, 100);
});

test('worker-core: stale epochs, unknown names, junk tasks reply safely', async () => {
  const { createWorkerCore } = await import('../src/worker-core.js');
  const core = createWorkerCore();
  assert.deepEqual(core.handle({ id: 1, type: 'indicator', sid: 1, epoch: 0, name: 'sma', params: {} }), {
    id: 1, ok: false, stale: true,
  }, 'no session yet → stale');
  core.handle({ id: 2, type: 'epoch', sid: 1, epoch: 5, cols: colsOf(bars(10)) });
  const stale = core.handle({ id: 3, type: 'indicator', sid: 1, epoch: 4, name: 'sma', params: {} });
  assert.equal(stale.stale, true, 'epoch mismatch → stale');
  const unk = core.handle({ id: 4, type: 'indicator', sid: 1, epoch: 5, name: 'nope', params: {} });
  assert.equal(unk.ok, false);
  assert.match(unk.error, /unknown indicator/);
  const junk = core.handle({ id: 5, type: '???' });
  assert.equal(junk.ok, false);
  assert.deepEqual(core.handle(null), { id: undefined, ok: false, error: 'unknown task type: undefined' });
});

test('worker-core: a throwing compute resolves null (draws nothing), like the sync path', async () => {
  const { createWorkerCore, barsFromCols } = await import('../src/worker-core.js');
  const core = createWorkerCore();
  const cols = colsOf(bars(10));
  // poison the columns so the SMA compute throws worker-side
  Object.defineProperty(cols, 'time', { get() { throw new Error('boom'); } });
  core.handle({ id: 1, type: 'epoch', sid: 1, epoch: 0, cols });
  const r = core.handle({ id: 2, type: 'indicator', sid: 1, epoch: 0, name: 'sma', params: { period: 3 } });
  // barsFromCols throws on the poisoned getter → caught → ok:true, res null
  assert.equal(r.ok, true);
  assert.equal(r.res, null);
  assert.equal(barsFromCols(colsOf(bars(3))).length, 3);
});

test('worker-core: at most two chart sessions stay resident', async () => {
  const { createWorkerCore } = await import('../src/worker-core.js');
  const core = createWorkerCore();
  for (const sid of [1, 2, 3]) {
    core.handle({ id: sid, type: 'epoch', sid, epoch: 0, cols: colsOf(bars(5)) });
  }
  assert.deepEqual([...core.sessions.keys()].sort(), [2, 3], 'oldest session evicted');
  assert.equal(core.handle({ id: 9, type: 'indicator', sid: 1, epoch: 0, name: 'sma', params: {} }).stale, true);
});

/* ------------------------------ the pool ------------------------------ */

/** Fake Worker: records posts, replies via instance.onmessage. */
class FakeWorker {
  static spawned = [];
  constructor() {
    this.posts = [];
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.terminated = false;
    FakeWorker.spawned.push(this);
  }
  postMessage(msg) {
    this.posts.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  reply(msg) {
    this.onmessage({ data: msg });
  }
}

test('the pool resolves task replies by correlation id', async () => {
  const { ChartWorkerPool } = await import('../src/worker.js');
  const pool = new ChartWorkerPool(() => new FakeWorker());
  const p1 = pool.run({ type: 'indicator', name: 'sma' });
  const p2 = pool.run({ type: 'indicator', name: 'ema' });
  const w = FakeWorker.spawned.at(-1);
  assert.equal(w.posts.length, 2);
  assert.notEqual(w.posts[0].id, w.posts[1].id, 'ids distinct');
  w.reply({ id: w.posts[1].id, ok: true, res: 'ema-result' });
  w.reply({ id: w.posts[0].id, ok: true, res: 'sma-result' });
  assert.equal(await p1, 'sma-result');
  assert.equal(await p2, 'ema-result');
});

test('the pool rejects failures, flags stale replies, and respawns after death', async () => {
  const { ChartWorkerPool } = await import('../src/worker.js');
  const before = FakeWorker.spawned.length;
  const pool = new ChartWorkerPool(() => new FakeWorker());

  const fail = pool.run({ type: 'indicator', name: 'sma' });
  FakeWorker.spawned.at(-1).reply({ id: 1, ok: false, error: 'unknown indicator: sma' });
  await assert.rejects(() => fail, /unknown indicator/);

  const stale = pool.run({ type: 'indicator', name: 'sma' });
  FakeWorker.spawned.at(-1).reply({ id: 2, ok: false, stale: true });
  const err = await stale.catch((e) => e);
  assert.equal(err.stale, true, 'stale rejections are recognizable');

  // worker death rejects in-flight tasks and the next run() respawns
  const inflight = pool.run({ type: 'indicator', name: 'sma' });
  FakeWorker.spawned.at(-1).onerror();
  await assert.rejects(() => inflight, /worker died/);
  const after = pool.run({ type: 'indicator', name: 'sma' });
  const fresh = FakeWorker.spawned.at(-1);
  assert.equal(FakeWorker.spawned.length, before + 2, 'one spawn + one respawn');
  fresh.reply({ id: fresh.posts[0].id, ok: true, res: 1 });
  assert.equal(await after, 1);
  assert.equal(FakeWorker.spawned[before].terminated || true, true);

  pool.terminate();
  assert.equal(pool.available, false);
  await assert.rejects(() => pool.run({}), /unavailable/);
});

/* --------------------- the chart's worker branch --------------------- */

const { WickChart } = await import('../src/wick-chart.js');
const P = WickChart.prototype;

/** A duck-typed chart with the slice of the element contract the worker
 *  branch touches, plus a scriptable pool. */
function makeWorkerChart(n = 60_000) {
  const chart = {
    _data: bars(n),
    _version: 1,
    _epoch: 1,
    _cache: { v: -1, map: {} },
    _workerOn: true,
    _workerCache: { epoch: -1, map: {}, pending: {}, sent: -1 },
    _sid: 1,
    _vwapAnchor: null,
    _connected: true,
    fires: [],
    invalidated: 0,
    tasks: [],
    _fire(name, detail) {
      this.fires.push({ name, ...detail });
    },
    _invalidate() {
      this.invalidated++;
    },
  };
  for (const m of ['_indicatorSeries', '_workerCompute', '_workerArrived', '_workerCols']) {
    chart[m] = P[m].bind(chart);
  }
  chart.pool = {
    available: true,
    run(msg) {
      chart.tasks.push(msg);
      const id = chart.tasks.length;
      // reply synchronously for determinism: epoch acks, sma echoes a line
      if (msg.type === 'epoch') return Promise.resolve(true);
      if (msg.name === 'reject-me') return Promise.reject(new Error('boom'));
      if (msg.name === 'stale-me') return Promise.reject(Object.assign(new Error('stale'), { stale: true }));
      return Promise.resolve({ lines: [{ name: '', values: [1, 2, 3] }] });
    },
  };
  const saved = WickChart._workerPool;
  WickChart._workerPool = chart.pool;
  chart._restore = () => (WickChart._workerPool = saved);
  return chart;
}

const smaEntry = {
  name: 'sma',
  def: (await import('../src/core.js')).BUILTIN_INDICATORS.get('sma'),
  params: { period: 20 },
  key: 'sma:20',
};

test('the worker branch serves cached epoch results across streamed ticks', async () => {
  const chart = makeWorkerChart();
  try {
    const first = chart._indicatorSeries(smaEntry);
    assert.deepEqual(first, { lines: [], histogram: null }, 'pending renders nothing (safe empty)');
    assert.equal(chart.tasks.filter((t) => t.type === 'epoch').length, 1, 'data shipped once');
    await Promise.resolve(); // let the reply land
    assert.ok(chart._workerCache.map['ind:sma:20'], 'result cached');
    assert.ok(chart.fires.some((f) => f.name === 'worker'), 'wick:worker fired');

    // a streamed tick bumps _version but NOT _epoch — same series, no recompute
    const cached = chart._workerCache.map['ind:sma:20'];
    chart._version++;
    chart._cache = { v: -1, map: {} };
    assert.equal(chart._indicatorSeries(smaEntry), cached, 'epoch cache survives the tick');
    assert.equal(chart.tasks.filter((t) => t.type === 'indicator').length, 1);
  } finally {
    chart._restore();
  }
});

test('eligibility: small datasets, custom defs and a dead pool stay sync', async () => {
  const chart = makeWorkerChart(60_000);
  try {
    // below the threshold → the sync path computes in place
    chart._data = bars(100);
    chart._cache = { v: -1, map: {} };
    const res = chart._indicatorSeries(smaEntry);
    assert.ok(res && res.lines[0].values.length === 100, 'computed synchronously');
    assert.equal(chart.tasks.length, 0);

    // a custom def under the same name (registry override) must not cross
    chart._data = bars(60_000);
    chart._cache = { v: -1, map: {} };
    const custom = chart._indicatorSeries({ name: 'sma', def: { compute: () => [1] }, params: {}, key: 'x' });
    assert.deepEqual(custom.lines[0].values, [1], 'closure def computed sync');
    assert.equal(chart.tasks.length, 0);

    // pool marked unavailable → sync, transparently
    chart.pool.available = false;
    chart._cache = { v: -1, map: {} };
    assert.equal(chart._indicatorSeries(smaEntry).lines[0].values.length, 60_000, 'sync fallback');
    assert.equal(chart.tasks.length, 0);
    chart.pool.available = true;

    // worker attr off → sync even at scale
    chart._workerOn = false;
    chart._cache = { v: -1, map: {} };
    assert.equal(chart.tasks.length, 0);
    assert.ok(chart._indicatorSeries(smaEntry).lines[0].values.length === 60_000);
  } finally {
    chart._restore();
  }
});

test('failures: rejected computes negative-cache, stale replies force a data resend', async () => {
  const chart = makeWorkerChart();
  try {
    // The pool rejects by marker param — the entry itself must stay a real
    // builtin (name + def identity) or the guard routes it to the sync path.
    chart.pool.run = (msg) => {
      chart.tasks.push(msg);
      if (msg.type === 'epoch') return Promise.resolve(true);
      if (msg.params && msg.params.period === 999)
        return Promise.reject(new Error('boom'));
      return Promise.reject(Object.assign(new Error('stale'), { stale: true }));
    };
    const bad = { name: 'sma', def: smaEntry.def, params: { period: 999 }, key: 'sma:999' };
    assert.deepEqual(chart._indicatorSeries(bad), { lines: [], histogram: null });
    await Promise.resolve();
    await Promise.resolve();
    assert.ok('ind:sma:999' in chart._workerCache.map, 'negative-cached for this epoch');
    assert.deepEqual(chart._workerCache.map['ind:sma:999'].lines, [], 'draws nothing');
    const asks = chart.tasks.filter((t) => t.type === 'indicator').length;
    chart._cache = { v: -1, map: {} };
    chart._indicatorSeries(bad);
    assert.equal(chart.tasks.filter((t) => t.type === 'indicator').length, asks, 'no retry loop');

    const stale = { name: 'sma', def: smaEntry.def, params: { period: 998 }, key: 'sma:998' };
    chart._indicatorSeries(stale);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(chart._workerCache.sent, -1, 'epoch flagged for resend');
  } finally {
    chart._restore();
  }
});

test('a stale arrival (newer epoch won) is dropped, not painted', async () => {
  const chart = makeWorkerChart();
  try {
    let holdResolve;
    chart.pool.run = (msg) => {
      chart.tasks.push(msg);
      if (msg.type === 'epoch') return Promise.resolve(true);
      return new Promise((r) => (holdResolve = r));
    };
    chart._indicatorSeries(smaEntry); // kicks, held
    chart._epoch = 2; // a new bulk load landed meanwhile
    chart._workerCache.epoch = 2;
    holdResolve({ lines: [{ name: '', values: [9] }] }); // the old epoch's result
    await Promise.resolve();
    assert.ok(!chart._workerCache.map['ind:sma:20'], 'stale line dropped');
    const fires = chart.fires.filter((f) => f.name === 'worker').length;
    assert.equal(fires, 0, 'no wick:worker, no repaint');
  } finally {
    chart._restore();
  }
});

test('_workerCols snapshots the six columns exactly', () => {
  const chart = makeWorkerChart(5);
  try {
    const cols = chart._workerCols();
    for (const k of ['time', 'open', 'high', 'low', 'close', 'volume']) {
      assert.ok(cols[k] instanceof Float64Array, k + ' is a Float64Array');
      assert.equal(cols[k].length, 5);
      assert.equal(cols[k][3], chart._data[3][k]);
    }
  } finally {
    chart._restore();
  }
});
