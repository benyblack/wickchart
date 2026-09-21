// PR #65 — incremental indicator updates: streamed ticks (append /
// forming-bar replace) patch online-capable series by recomputing a bounded
// tail with the SAME batch definition, instead of a full-history recompute
// per indicator per version. The property tests prove equivalence against
// batch recomputes across long tick sequences, for every online indicator.
import test from 'node:test';
import assert from 'node:assert/strict';

const { WickChart } = await import('../src/wick-chart.js');
const core = await import('../src/core.js');
const P = WickChart.prototype;
const { BUILTIN_INDICATORS, normalizeIndicatorResult } = core;

/** Deterministic random walk of bars. */
function walk(n, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const bars = [];
  let p = 100;
  let t = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    p *= 1 + (rnd() - 0.5) * 0.01;
    bars.push({
      time: (t += 60_000), open: p * 0.999, high: p * 1.004,
      low: p * 0.995, close: p, volume: Math.round(rnd() * 900),
    });
  }
  return bars;
}

/** A duck-typed chart exposing the indicator pipeline (sync mode). */
function makeChart(bars, indicators) {
  const chart = {
    _data: bars,
    _version: 1,
    _epoch: 1,
    _cache: { v: -1, map: {} },
    _workerOn: false,
    _workerCache: { epoch: -1, map: {}, pending: {}, sent: -1 },
    _onlineSeries: { epoch: -1, map: {} },
    _vwapAnchor: null,
    _ind: { overlays: [], panes: [] },
    _connected: true,
    computeCalls: 0,
    _fire() {},
    _invalidate() {},
  };
  const parse = (str) => {
    const entries = String(str).split(/\s+/).filter(Boolean).map((tok) => {
      const [name, prd] = tok.split(':');
      const def = BUILTIN_INDICATORS.get(name);
      const params = { ...def.params };
      if (prd != null) {
        if (name === 'macd') { params.fast = 8; params.slow = 21; params.signal = 5; }
        else params.period = Number(prd) || def.params.period;
      }
      return { name, def, params, key: tok, color: null };
    });
    chart._ind.overlays = entries.filter((e) => e.def.kind === 'overlay');
    chart._ind.panes = entries.filter((e) => e.def.kind !== 'overlay');
  };
  parse(indicators);
  for (const m of ['_indicatorSeries', '_seedOnline', '_onlineTick', '_patchSeriesTail']) {
    chart[m] = P[m].bind(chart);
  }
  const savedPool = WickChart._workerPool;
  WickChart._workerPool = null;
  chart._restore = () => (WickChart._workerPool = savedPool);
  return chart;
}

/** All lines of a result as flat [values] arrays (histogram included). */
const linesOf = (res) => {
  const out = res.lines.map((l) => l.values);
  if (Array.isArray(res.histogram)) out.push(res.histogram);
  return out;
};

/* ------------------- the equivalence property ------------------- */

const ONLINE = 'sma:20 ema:50 bb:20 rsi:14 macd atr:14 stoch:14 cci:20 wr:14 donchian:20 keltner:20';
const SKIP = 'vwap obv supertrend';

test('online series stay equivalent to batch recomputes across streamed ticks', () => {
  const chart = makeChart(walk(900), ONLINE);
  try {
    const entries = chart._ind.overlays.concat(chart._ind.panes);
    // first render: full compute + seed
    for (const e of entries) chart._indicatorSeries(e);

    // 60 streamed ticks: mostly forming-bar replaces, some appends
    let s = 99;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let tick = 0; tick < 60; tick++) {
      const d = chart._data;
      if (rnd() < 0.35) {
        // append a new bar
        const last = d[d.length - 1];
        const c = last.close * (1 + (rnd() - 0.5) * 0.008);
        d.push({
          time: last.time + 60_000, open: last.close, high: Math.max(last.close, c) * 1.002,
          low: Math.min(last.close, c) * 0.998, close: c, volume: Math.round(rnd() * 900),
        });
      } else {
        // replace the forming bar with a corrected close
        const last = d[d.length - 1];
        const c = last.close * (1 + (rnd() - 0.5) * 0.006);
        d[d.length - 1] = { ...last, close: c, high: Math.max(last.high, c), low: Math.min(last.low, c) };
      }
      chart._version++;
      chart._onlineTick();

      // every online series must match a fresh batch compute over the data:
      // the write window (last ~p bars) tightly, deeper history exactly —
      // those values were computed at the epoch and are never rewritten
      for (const e of entries) {
        const online = linesOf(chart._indicatorSeries(e));
        const batch = linesOf(normalizeIndicatorResult(e.def.compute(chart._data, { ...e.params })));
        assert.equal(online.length, batch.length, e.name + ' line count');
        let pmax = 0;
        for (const v of Object.values(e.params || {})) {
          if (Number.isFinite(+v) && +v > pmax) pmax = +v;
        }
        // the write window sweeps forward with the data: anything within
        // p of ANY tick's end was rewritten with a converged tail value
        // (~1e-9); only indices below the first window stay bit-exact
        const writeFrom = 900 - pmax - 2;
        for (let li = 0; li < batch.length; li++) {
          assert.equal(online[li].length, chart._data.length, `${e.name} line ${li} stays data-aligned`);
          for (let i = 0; i < batch[li].length; i++) {
            const a = online[li][i];
            const b = batch[li][i];
            if (b == null) continue; // batch warm-up
            if (i >= writeFrom) {
              assert.ok(
                Math.abs(a - b) <= 1e-7 + 1e-9 * Math.abs(b),
                `${e.name} tick ${tick} index ${i}: online ${a} vs batch ${b}`
              );
            } else {
              assert.ok(
                Math.abs(a - b) <= 1e-12,
                `${e.name} tick ${tick} index ${i}: untouched history drifted (${a} vs ${b})`
              );
            }
          }
        }
      }
    }
  } finally {
    chart._restore();
  }
});

test('a tick serves the patched series without entering the sync compute', () => {
  const chart = makeChart(walk(700), 'sma:20 rsi:14');
  try {
    const entries = chart._ind.overlays.concat(chart._ind.panes);
    for (const e of entries) chart._indicatorSeries(e);
    const seeds = { ...chart._onlineSeries.map };
    assert.ok(seeds['ind:sma:20'] && seeds['ind:rsi:14'], 'both seeded');

    const d = chart._data;
    const last = d[d.length - 1];
    d[d.length - 1] = { ...last, close: last.close * 1.004 };
    chart._version++;
    const cacheVersionBefore = chart._cache.v;
    chart._onlineTick();

    for (const e of entries) {
      const res = chart._indicatorSeries(e);
      assert.strictEqual(res, seeds['ind:' + e.key].res, 'the patched object, no recompute');
      assert.strictEqual(seeds['ind:' + e.key].v, chart._version, 'version stamp advanced');
    }
    // the sync path never ran for this version (its cache is still stamped
    // with the pre-tick version — the head-check short-circuits first)
    assert.equal(chart._cache.v, cacheVersionBefore, 'sync compute path untouched');

    // and the tail recompute only ever saw a bounded slice of the history
    let maxSlice = 0;
    const origPatch = chart._patchSeriesTail;
    chart._patchSeriesTail = (res, entry, d2) => {
      const def = entry.def;
      entry.def = { ...def, compute: (bars, p) => {
        maxSlice = Math.max(maxSlice, bars.length);
        return def.compute(bars, p);
      } };
      try {
        return origPatch(res, entry, d2);
      } finally {
        entry.def = BUILTIN_INDICATORS.get(entry.name); // restore identity
      }
    };
    d.push({ ...d[d.length - 1], time: d[d.length - 1].time + 60_000 });
    chart._version++;
    chart._onlineTick();
    assert.ok(maxSlice > 0 && maxSlice <= 401, `tail slice bounded (saw ${maxSlice} bars)`);
  } finally {
    chart._restore();
  }
});

test('a historical insert (backfill) forces a fresh recompute, then ticking resumes', () => {
  const chart = makeChart(walk(600), 'sma:20');
  try {
    const [entry] = chart._ind.overlays;
    chart._indicatorSeries(entry);
    // backfill: insert an older bar in place (update()'s non-live path)
    const d = chart._data;
    d.splice(3, 0, { time: d[2].time + 30_000, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    chart._version++;
    chart._onlineTick; // not called on the non-live path — but even if it were:
    chart._onlineTick();
    chart._version++; // and a subsequent tick
    const res = chart._indicatorSeries(entry);
    const batch = normalizeIndicatorResult(entry.def.compute(d, entry.params));
    const a = res.lines[0].values;
    const b = batch.lines[0].values;
    assert.equal(a.length, d.length, 'realigned with the inserted bar');
    for (let i = 0; i < b.length; i++) {
      if (b[i] == null) continue;
      assert.ok(Math.abs(a[i] - b[i]) < 1e-9, `index ${i}: ${a[i]} vs ${b[i]}`);
    }
  } finally {
    chart._restore();
  }
});

test('cumulative and stateful builtins are excluded and keep recomputing', () => {
  const chart = makeChart(walk(500), SKIP);
  try {
    const entries = chart._ind.overlays.concat(chart._ind.panes);
    for (const e of entries) chart._indicatorSeries(e);
    const d = chart._data;
    const last = d[d.length - 1];
    d[d.length - 1] = { ...last, close: last.close * 1.01 };
    chart._version++;
    chart._onlineTick();
    for (const e of entries) {
      assert.ok(!chart._onlineSeries.map['ind:' + e.key], e.name + ' never seeded online');
      const fresh = chart._indicatorSeries(e);
      const batch = normalizeIndicatorResult(e.def.compute(d, { ...e.params }));
      assert.deepEqual(fresh.lines[0].values.length, batch.lines[0].values.length, e.name + ' recomputed');
    }
  } finally {
    chart._restore();
  }
});

test('custom defs under a builtin name are never patched (closure boundary)', () => {
  const chart = makeChart(walk(300), 'sma:20');
  try {
    const custom = { name: 'sma', def: { kind: 'overlay', compute: (bars, p) => bars.map((b) => b.close) }, params: { period: 5 }, key: 'sma:20' };
    chart._ind.overlays = [custom];
    const res = chart._indicatorSeries(custom);
    assert.ok(!chart._onlineSeries.map['ind:sma:20'], 'closure def not seeded');
    const d = chart._data;
    d[d.length - 1] = { ...d[d.length - 1], close: d[d.length - 1].close * 2 };
    chart._version++;
    chart._onlineTick();
    const after = chart._indicatorSeries(custom);
    assert.equal(after.lines[0].values[after.lines[0].values.length - 1], d[d.length - 1].close, 'sync recompute, no patch');
    assert.notEqual(after, res, 'a fresh result was computed');
  } finally {
    chart._restore();
  }
});

test('worker-arrived bases seed the online path, then ticks patch them in place', async () => {
  // above the 50k worker threshold, or the sync path answers instead
  const chart = makeChart(walk(60_000), 'sma:20');
  try {
    const [entry] = chart._ind.overlays;
    chart._workerOn = true;
    chart.pool = {
      available: true,
      run: (msg) => {
        if (msg.type === 'epoch') return Promise.resolve(true);
        return Promise.resolve({ lines: [{ name: '', values: chart._data.map((b) => b.close) }] });
      },
    };
    WickChart._workerPool = chart.pool;
    chart._workerCompute = P._workerCompute.bind(chart);
    chart._workerArrived = P._workerArrived.bind(chart);
    chart._workerCols = P._workerCols.bind(chart);
    chart._fire = (name) => chart.fires.push(name);
    chart.fires = [];

    const got = chart._indicatorSeries(entry);
    assert.deepEqual(got, { lines: [], histogram: null, fill: null }, 'pending first');
    await new Promise((r) => setTimeout(r, 0));
    const base = chart._workerCache.map['ind:sma:20'];
    assert.ok(base, 'worker base arrived');
    assert.strictEqual(chart._onlineSeries.map['ind:sma:20'].res, base, 'online seeded FROM the worker base');

    // a tick patches the very same array — the forming bar stays fresh
    const d = chart._data;
    const last = d[d.length - 1];
    const newClose = last.close * 1.05;
    d[d.length - 1] = { ...last, close: newClose };
    chart._version++;
    chart._onlineTick();
    const patched = chart._indicatorSeries(entry);
    assert.strictEqual(patched, base, 'same series object, patched in place');
    let sum = 0;
    for (let i = d.length - 20; i < d.length; i++) sum += d[i].close;
    assert.ok(Math.abs(patched.lines[0].values[d.length - 1] - sum / 20) < 1e-9, 'fresh SMA on the forming bar');
  } finally {
    chart._restore();
  }
});
