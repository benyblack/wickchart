// Shape & pattern search — z-normalized subsequence similarity (MASS-style
// FFT search + greedy exclusion), its chart API (`findShape`/`clearShape`,
// `wick:shape`) and its rendering wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shapeSearch } from '../src/core.js';

const { WickChart } = await import('../src/wick-chart.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

/** Deterministic PRNG bars, same LCG family as the e2e fixtures. */
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function series(n, seed = 7) {
  const rand = rng(seed);
  const out = [];
  let v = 100;
  for (let i = 0; i < n; i++) {
    v *= 1 + (rand() - 0.5) * 0.03 + Math.sin(i / 11) * 0.004;
    out.push(v);
  }
  return out;
}

/**
 * Independent brute-force reference: direct per-window z-normalization and
 * dot products, O(n·m), then the same greedy non-overlapping selection.
 * The production path goes through an FFT — a different algebra entirely.
 */
function bruteShape(s, qs, m, { maxMatches = 8, minScore = -1 } = {}) {
  const q = s.slice(qs, qs + m);
  const qmu = q.reduce((a, b) => a + b, 0) / m;
  const qsd = Math.sqrt(q.reduce((a, b) => a + (b - qmu) ** 2, 0) / m);
  if (qsd < 1e-12) return [];
  const n = s.length;
  const d2 = new Map();
  for (let i = 0; i + m <= n; i++) {
    if (i < qs + m && qs < i + m) continue; // query overlap
    let mu = 0;
    for (let j = 0; j < m; j++) mu += s[i + j];
    mu /= m;
    let ss = 0;
    for (let j = 0; j < m; j++) ss += (s[i + j] - mu) ** 2;
    const sd = Math.sqrt(ss / m);
    if (sd < 1e-12) continue;
    let dot = 0;
    for (let j = 0; j < m; j++) dot += ((q[j] - qmu) / qsd) * ((s[i + j] - mu) / sd);
    d2.set(i, 2 * m * (1 - Math.max(-1, Math.min(1, dot / m))));
  }
  const order = [...d2.keys()].sort((a, b) => d2.get(a) - d2.get(b));
  const out = [];
  const taken = [];
  for (const i of order) {
    if (out.length >= maxMatches) break;
    if (1 - d2.get(i) / (2 * m) < minScore) break;
    if (taken.some((t) => Math.abs(i - t) < m)) continue;
    taken.push(i);
    out.push({ start: i, length: m, distance: Math.sqrt(d2.get(i)), score: 1 - d2.get(i) / (2 * m) });
  }
  return out;
}

/* ---------------------------- the math ---------------------------- */

test('shapeSearch: differential against a brute-force O(n·m) reference', () => {
  const s = series(600, 7);
  for (const [qs, m] of [[50, 24], [200, 8], [300, 64], [400, 100]]) {
    const got = shapeSearch(s, qs, m, { maxMatches: 6 });
    const want = bruteShape(s, qs, m, { maxMatches: 6 });
    assert.deepEqual(got.map((x) => x.start), want.map((x) => x.start), `starts qs=${qs} m=${m}`);
    assert.equal(got.length, want.length);
    for (let k = 0; k < got.length; k++) {
      assert.ok(Math.abs(got[k].score - want[k].score) < 1e-9, `score[${k}] qs=${qs} m=${m}`);
      assert.ok(Math.abs(got[k].distance - want[k].distance) < 1e-7, `distance[${k}] qs=${qs} m=${m}`);
      assert.ok(got[k].distance >= 0 && got[k].score <= 1);
    }
  }
});

test('shapeSearch: exact repeats all score 1, non-overlapping, query excluded', () => {
  const s = [];
  for (let r = 0; r < 6; r++) for (let i = 0; i < 30; i++) s.push(100 + r + i * 0.5 + Math.sin(i) * 3);
  const got = shapeSearch(s, 60, 20, { maxMatches: 10 });
  // ties at score 1 order by float noise — assert the set, not the sequence
  assert.deepEqual(got.map((x) => x.start).sort((a, b) => a - b), [0, 30, 90, 120, 150]); // 60 is the query
  for (const m of got) assert.ok(Math.abs(m.score - 1) < 1e-9);
  for (let k = 1; k < got.length; k++) assert.ok(Math.abs(got[k].start - got[k - 1].start) >= 20);
});

test('shapeSearch: an inverted window scores ≈ −1 (and ranks below a true repeat)', () => {
  // ramp, inverted ramp, then the ramp again — the only three full-length
  // windows are the two copies and the query itself
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const s = [...up, ...up.slice().reverse(), ...up];
  const got = shapeSearch(s, 0, 40, { maxMatches: 8 });
  const repeat = got.find((m) => m.start === 80);
  const inv = got.find((m) => m.start === 40);
  assert.ok(repeat, 'the true repeat is found');
  assert.ok(Math.abs(repeat.score - 1) < 1e-9);
  assert.ok(inv, 'the inverted window is in the results');
  assert.ok(inv.score < -0.99, `inverted score ${inv.score}`);
  assert.ok(repeat.score > inv.score, 'the repeat outranks the inversion');
});

test('shapeSearch: degenerate inputs', () => {
  assert.deepEqual(shapeSearch([5, 5, 5, 5, 5, 5, 5, 5, 5, 5], 0, 8), []); // flat query
  assert.deepEqual(shapeSearch([1, 2, 3], 0, 2), []); // too little data
  assert.deepEqual(shapeSearch(series(100), 500, 10), shapeSearch(series(100), 99, 10)); // qStart clamps
  const s = series(200);
  assert.equal(shapeSearch(s, 40, 3, { maxMatches: 4 }).length, 4); // qLen clamps up to 8
});

test('shapeSearch: maxMatches and the minScore floor', () => {
  const s = series(400);
  assert.equal(shapeSearch(s, 100, 30, { maxMatches: 2 }).length, 2);
  const strict = shapeSearch(s, 100, 30, { minScore: 0.99 });
  assert.ok(strict.every((m) => m.score >= 0.99));
  const loose = shapeSearch(s, 100, 30, { maxMatches: 50 });
  assert.ok(strict.length <= loose.length);
});

test('shapeSearch: offset-invariant — a 1e9 baseline must not break matching', () => {
  const s0 = [];
  for (let r = 0; r < 5; r++) for (let i = 0; i < 30; i++) s0.push(100 + r + i * 0.5 + Math.sin(i) * 3);
  const hi = s0.map((v) => v + 1e9); // high-valued instrument, same movement
  const got = shapeSearch(hi, 60, 20, { maxMatches: 10 });
  assert.deepEqual(got.map((x) => x.start).sort((a, b) => a - b), [0, 30, 90, 120]);
  for (const m of got) assert.ok(Math.abs(m.score - 1) < 1e-6, `offset-corrupted score ${m.score}`);
});

test('shapeSearch: FFT path stays interactive at 100k bars (not O(n·m))', () => {
  const s = series(100_000, 42);
  const t0 = performance.now();
  const got = shapeSearch(s, 50_000, 200, { maxMatches: 8 });
  const ms = performance.now() - t0;
  assert.ok(got.length > 0);
  assert.ok(ms < 1500, `100k-bar search took ${ms.toFixed(0)} ms — the FFT path degenerated`);
});

/* ------------------------ chart-level contract ------------------------ */

function fakeChart(bars) {
  const events = [];
  return {
    events,
    _data: bars,
    _shape: null,
    _brushSel: null,
    invalidations: 0,
    _invalidate() { this.invalidations++; },
    _fire(name, detail) { events.push({ name, detail }); },
    findShape: WickChart.prototype.findShape,
    clearShape: WickChart.prototype.clearShape,
    get shapeResult() {
      return Object.getOwnPropertyDescriptor(WickChart.prototype, 'shapeResult').get.call(this);
    },
  };
}

const mkBars = (n) =>
  Array.from({ length: n }, (_, i) => {
    const o = 100 + (i % 30) * 0.5 + Math.floor(i / 30) + Math.sin(i % 30) * 2;
    return { time: 1_700_000_000_000 + i * 60_000, open: o, close: o + 1, high: o + 2, low: o - 2, volume: 100 };
  });

test('findShape: time-based query, event payload, render state, clear', () => {
  const bars = mkBars(180);
  const f = fakeChart(bars);
  const res = f.findShape({ from: bars[60].time, to: bars[79].time });
  assert.ok(res, 'result returned');
  assert.equal(res.query.from, bars[60].time);
  assert.equal(res.query.to, bars[79].time);
  assert.ok(res.matches.length >= 1);
  for (const m of res.matches) {
    assert.ok(Number.isFinite(m.from) && Number.isFinite(m.to));
    assert.ok(m.score <= 1 && m.score >= -1);
    assert.ok(m.to > m.from);
  }
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].name, 'shape');
  assert.deepEqual(f.events[0].detail.query, res.query);
  assert.ok(f.invalidations > 0, 'render invalidated');
  assert.deepEqual(f.shapeResult, res, 'getter is a stable copy');
  f.clearShape();
  assert.equal(f.shapeResult, null);
  assert.ok(f.invalidations > 1);
  f.clearShape(); // idempotent
});

test('findShape: defaults to the brush selection; rejects unusable queries', () => {
  const bars = mkBars(180);
  const f = fakeChart(bars);
  assert.equal(f.findShape(), null); // no range, no brush
  f._brushSel = { i0: 30, i1: 55, stats: {} };
  const res = f.findShape();
  assert.equal(res.query.from, bars[30].time);
  assert.equal(f.findShape({ from: bars[10].time, to: bars[12].time }), null); // shorter than the floor
});

test('findShape: a range past the clamp reports exactly what was searched', () => {
  const bars = mkBars(900);
  const f = fakeChart(bars);
  const res = f.findShape({ from: bars[20].time, to: bars[880].time });
  assert.ok(res, 'search runs');
  // the stored query spans SHAPE_MAX_WINDOW bars — no match can overlap it
  assert.equal(f._shape.i1 - f._shape.i0, 749);
  assert.equal(res.query.from, bars[20].time);
  assert.equal(res.query.to, bars[20 + 749].time);
  for (const m of f._shape.matches) {
    assert.ok(m.i1 < f._shape.i0 || m.i0 > f._shape.i1, 'no match overlaps the reported query');
  }
});

test('component contract: bands render, state clears with the data', () => {
  const src = read('src/wick-chart.js');
  assert.match(src, /hexToRgba\(pal\.accent, 0\.09\)/, 'match bands are drawn');
  assert.match(src, /hexToRgba\(pal\.up, 0\.14\)/, 'the query band is distinct');
  const sd = src.slice(src.indexOf('setData(bars) {'), src.indexOf('setData(bars) {') + 400);
  assert.match(sd, /this\._shape = null/, 'setData clears the shape result');
  // setData([]) early-returns through clearData() — the reset must live there too
  const cd = src.slice(src.indexOf('clearData() {'), src.indexOf('clearData() {') + 400);
  assert.match(cd, /this\._shape = null/, 'clearData clears the shape result');
  // backfill prepends shift every index; the shape result rebases, not drops
  const bf = src.slice(src.indexOf('mergeOlderData(this._data, older)'), src.indexOf('mergeOlderData(this._data, older)') + 700);
  assert.match(bf, /this\._shape\.i0 \+= added/, 'backfill rebases the shape indices');
});
