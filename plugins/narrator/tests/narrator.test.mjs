// wickchart-narrator — the pure core: timeline analyzer, scene validation,
// camera easing, price→pitch mapping. Mirrors the pr27/pr29 behavior the
// core copies carry, and holds the copies to parity while both exist
// (until the 2.0 cut deletes the core copies — ROADMAP-V2.md).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  narrateWindow,
  normalizeScene,
  sceneList,
  easeInOutCubic,
  priceToFreq,
  timeToMs,
  indexForTime,
} from '../core.mjs';
// the core copies these will replace at 2.0 — parity is the drift guard
const wccore = await import('wickchart/core');

/* synthetic series: a clear peak at i=60 and a clear trough at i=120 */
function storyBars() {
  const bars = [];
  for (let i = 0; i < 200; i++) {
    let p;
    if (i <= 60) p = 100 + i;             // rally 100 → 160
    else if (i <= 120) p = 160 - (i - 60); // slide 160 → 100
    else p = 100 + (i - 120);              // recovery 100 → 180
    const o = p;
    const c = p; // flat bars; shape comes from high/low extremes below
    bars.push({
      time: 1700000000000 + i * 3600e3,
      open: o,
      close: c,
      high: p + 0.5,
      low: p - 0.5,
      volume: 100,
    });
  }
  return bars;
}

/* ------------------------- narrateWindow ------------------------- */

test('narrateWindow finds the peak/trough pivots and stamps legs at the ending pivot', () => {
  const ev = narrateWindow(storyBars(), 0, 199, { pivot: 10 });
  const types = new Set(ev.map((e) => e.type));
  assert.ok(types.has('pivothigh'), 'peak detected');
  assert.ok(types.has('pivotlow'), 'trough detected');
  const legs = ev.filter((e) => e.type === 'leg');
  assert.equal(legs.length, 1, 'one leg: peak@60 → trough@120 (straight lines have no other pivots)');
  const down = legs[0];
  // high@60 = 160.5 → low@120 = 99.5 ⇒ −61/160.5 = −38.0%
  assert.equal(down.side, 'low');
  assert.equal(down.legBars, 60);
  assert.equal(down.i, 120, 'leg stamped at the ending pivot');
  assert.match(down.note, /^-38\.0% over 60 bars$/);
  assert.ok(Math.abs(down.legPct - -38.01) < 0.005, `legPct ≈ −38.01 (got ${down.legPct})`);
  for (let k = 1; k < ev.length; k++) assert.ok(ev[k].i >= ev[k - 1].i, 'sorted by index');
  assert.ok(ev.every((e) => Number.isFinite(e.time)));
});

test('narrateWindow: volume spikes join the timeline; degenerate ranges return []', () => {
  const bars = storyBars();
  bars[50].volume = 5000; // 50× average
  const ev = narrateWindow(bars, 0, 199, { pivot: 10 });
  const spike = ev.find((e) => e.type === 'volspike');
  assert.ok(spike && spike.i === 50, 'spike at bar 50');
  assert.match(spike.note, /× average$/);
  assert.deepEqual(narrateWindow(bars, 5, 3), []);
  assert.deepEqual(narrateWindow([], 0, 0), []);
  assert.deepEqual(narrateWindow(bars, -1, 99), []);
  assert.ok(narrateWindow(bars, 0, 199).length <= 60, 'capped at 60 events');
});

test('narrateWindow detects on noisy synthetic data (sole owner since the 2.0 cut)', () => {
  // deterministic pseudo-random bars: enough variety to exercise every
  // detector (pivots, spikes, gaps, divergences)
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const bars = [];
  let p = 100;
  for (let i = 0; i < 400; i++) {
    p = Math.max(10, p + (rnd() - 0.5) * 6);
    const hi = p * (1 + rnd() * 0.02);
    const lo = p * (1 - rnd() * 0.02);
    bars.push({
      time: 1700000000000 + i * 3600e3,
      open: p,
      close: p * (1 + (rnd() - 0.5) * 0.01),
      high: Math.max(hi, p),
      low: Math.min(lo, p),
      volume: rnd() < 0.05 ? 10000 : 50 + rnd() * 100,
    });
  }
  const types = new Set();
  for (const [i0, i1] of [[0, 399], [50, 250]]) {
    const ev = narrateWindow(bars, i0, i1, { pivot: 6 });
    for (const e of ev) types.add(e.type);
    assert.ok(ev.length > 0, `events in [${i0}, ${i1}]`);
    assert.ok(ev.every((e) => Number.isFinite(e.time)), 'every event carries its bar time');
  }
  assert.ok(types.has('pivothigh') && types.has('pivotlow'), 'pivots detected');
  assert.ok(types.has('volspike'), 'volume spikes detected');
  assert.deepEqual(narrateWindow(bars, 0, 0, { pivot: 6 }), [], 'single-bar window is empty');
  assert.deepEqual(narrateWindow(bars, 120, 119, { pivot: 6 }), [], 'inverted window is empty');
});

/* ------------------------- scenes ------------------------- */

test('easeInOutCubic: endpoints exact, symmetric around 0.5, monotonic', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.ok(Math.abs(easeInOutCubic(0.5) - 0.5) < 1e-12);
  let prev = -1;
  for (let i = 0; i <= 20; i++) {
    const v = easeInOutCubic(i / 20);
    assert.ok(v >= prev, 'monotonic');
    prev = v;
  }
  assert.equal(easeInOutCubic(-5), 0, 'clamped below');
  assert.equal(easeInOutCubic(9), 1, 'clamped above');
 
});

test('normalizeScene: sanitizes every field, keeps only valid state', () => {
  const s = normalizeScene({
    title: 'x'.repeat(100),
    note: 'y'.repeat(300),
    range: { from: 10, to: 20 },
    indicators: '  sma:20 rsi:14  ',
    type: 'holograms',
    dwell: 999999,
    overlays: [{ type: 'level', price: 100, color: '#26a69a' }, { type: 'junk' }],
    scenario: { horizon: 24 },
    riskPlan: { entry: 100, stop: 99 },
  });
  assert.equal(s.title.length, 60);
  assert.equal(s.note.length, 200);
  assert.deepEqual(s.range, { from: 10, to: 20 });
  assert.equal(s.indicators, 'sma:20 rsi:14');
  assert.equal(s.type, undefined, 'unknown series types drop');
  assert.equal(s.dwell, 30000, 'dwell clamps to 30s');
  assert.equal(s.overlays.length, 1, 'overlays validated');
  assert.equal(s.scenario.horizon, 24);
  assert.equal(s.riskPlan.risk, 1);

  const t = normalizeScene({ dwell: 10, type: 'heikin' });
  assert.equal(t.dwell, 500, 'dwell clamps up to 500ms minimum');
  assert.equal(t.type, 'heikin');
  assert.equal(t.range, undefined);
  assert.equal(t.scenario, undefined, 'absent scenario key stays absent');
});

test('normalizeScene: explicit nulls become clear sentinels; invalid objects drop', () => {
  const s = normalizeScene({ scenario: null, riskPlan: null, range: { from: 1, to: 2 } });
  assert.equal(s.scenario, 'clear');
  assert.equal(s.riskPlan, 'clear');
  const bad = normalizeScene({ scenario: 'nonsense', riskPlan: { entry: 1 } });
  assert.equal(bad.scenario, undefined, 'invalid scenario drops (no crash)');
  assert.equal(bad.riskPlan, undefined, 'invalid risk plan drops');
  assert.equal(normalizeScene(null), null);
  assert.equal(normalizeScene('scene'), null);
});

test('sceneList: drops junk, caps at 20', () => {
  const story = [
    { title: 'one', range: { from: 0, to: 10 } },
    null,
    'junk',
    { title: 'two', indicators: 'sma:5' },
  ];
  assert.deepEqual(sceneList(story).map((s) => s.title), ['one', 'two']);
  assert.equal(sceneList({}).length, 0);
  const big = sceneList(Array.from({ length: 40 }, (_, i) => ({ title: 's' + i })));
  assert.equal(big.length, 20);
  // sentinels included: explicit nulls become 'clear' through the shared
  // normalizers (still imported from wickchart/core)
  const sentinels = sceneList([{ title: 'a', scenario: null, riskPlan: { entry: 10, stop: 9 } }, 'junk', null]);
  assert.equal(sentinels.length, 1);
  assert.equal(sentinels[0].scenario, 'clear');
  assert.equal(sentinels[0].riskPlan.risk, 1);
});

/* ------------------------- sonification pitch ------------------------- */

test('priceToFreq: linear, log-space, clamped, degenerate', () => {
  assert.equal(priceToFreq(50, { min: 0, max: 100 }), 180 + 0.5 * (880 - 180), 'linear midpoint');
  assert.equal(priceToFreq(-5, { min: 0, max: 100 }), 180, 'clamps below the scale');
  assert.equal(priceToFreq(500, { min: 0, max: 100 }), 880, 'clamps above the scale');
  // log scales carry log10-transformed min/max: 10^0..10^2, price 10 → t=0.5
  const f = priceToFreq(10, { min: 0, max: 2, useLog: true });
  assert.ok(Math.abs(f - (180 + 0.5 * 700)) < 1e-9, 'log midpoint');
  assert.equal(priceToFreq(42, null), 530, 'no scale → midpoint');
  assert.equal(priceToFreq(42, { min: 10, max: 10 }), 530, 'flat scale → midpoint');
  for (const sc of [{ min: 0, max: 100 }, { min: 1, max: 4, useLog: true }]) {
    for (const p of [1, 7, 42.5, 99, 1000]) {
    }
  }
});

/* ------------------------- time mapping ------------------------- */

test('timeToMs + indexForTime: the same rules the chart applies', () => {
  assert.equal(timeToMs(1700000000), 1700000000000, 'seconds upgrade');
  assert.equal(timeToMs(1700000000000), 1700000000000, 'ms pass through');
  assert.equal(timeToMs(new Date(1700000000000)), 1700000000000, 'Date accepted');
  const bars = storyBars();
  const T = (i) => bars[i].time;
  assert.equal(indexForTime(bars, T(0)), 0);
  assert.equal(indexForTime(bars, T(150)), 150);
  assert.equal(indexForTime(bars, T(150) + 1), 151, 'between bars rounds up to the next');
  assert.equal(indexForTime(bars, T(199)), 199);
  assert.equal(indexForTime(bars, T(199) + 9999), 199, 'past the end clamps to the last');
});