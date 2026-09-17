// wickchart-narrator — the attach layer: instance methods installed on the
// chart, playback interruption, the sonify gate, capture/play of stories.
// The chart fakes below carry the documented element contract (public data /
// range / event surface + the camera internals the plan reserves for the
// first-party plugin family).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { attachNarrator } from '../narrator.mjs';
const { WickChart } = await import('../../../src/wick-chart.js');

const read = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');

/* synthetic series: a clear peak at i=60 and a clear trough at i=120 */
function storyBars() {
  const bars = [];
  for (let i = 0; i < 200; i++) {
    let p;
    if (i <= 60) p = 100 + i;
    else if (i <= 120) p = 160 - (i - 60);
    else p = 100 + (i - 120);
    bars.push({ time: 1700000000000 + i * 3600e3, open: p, close: p, high: p + 0.5, low: p - 0.5, volume: 100 });
  }
  return bars;
}

function narratableChart() {
  const events = [];
  const attrs = {};
  return {
    events, attrs,
    _connected: true,
    data: storyBars(),
    _view: { rightIndex: 199, spacing: 4 },
    _ly: { plotRight: 400, main: { h: 200 } },
    _auto: true,
    _overlays: [],
    _scenario: null,
    _riskPlan: null,
    _lastScale: { min: 0, max: 200 },
    _minSpacing() { return 1; },
    _clampView() {},
    _invalidate() {},
    _emitRange() {},
    dispatchEvent(e) { events.push({ name: e.type, detail: e.detail }); return true; },
    getAttribute(k) { return attrs[k] ?? null; },
    setAttribute(k, v) { attrs[k] = String(v); },
    getVisibleRange() {
      const d = this.data;
      return { from: d[50].time, to: d[d.length - 1].time };
    },
    get overlays() { return this._overlays; },
    setOverlays(o) { this._overlays = o; },
    get scenario() { return this._scenario; },
    setScenario(s) { this._scenario = s; },
    clearScenario() { this._scenario = null; },
    get riskPlan() { return this._riskPlan; },
    setRiskPlan(p) { this._riskPlan = p; },
    clearRiskPlan() { this._riskPlan = null; },
  };
}

const T = (i) => 1700000000000 + i * 3600e3;

/* ------------------------- attach / detach ------------------------- */

test('attachNarrator installs the family as own methods and is idempotent', () => {
  const c = narratableChart();
  const a = attachNarrator(c);
  const b = attachNarrator(c);
  assert.equal(a, b, 'second attach returns the same controller');
  for (const m of ['narrate', 'walk', 'stopWalk', 'playRange', 'captureScene', 'getStory', 'playStory', 'stopStory', '_maybeSonify', '_stopPlayback']) {
    assert.ok(c.hasOwnProperty(m), `${m} installed as an own property`);
    assert.equal(typeof c[m], 'function');
  }
  assert.ok(c.narrate().length > 0, 'installed narrate answers');

  a.detach();
  for (const m of ['narrate', 'walk', 'stopWalk', 'playRange', 'captureScene', 'getStory', 'playStory', 'stopStory', '_maybeSonify', '_stopPlayback']) {
    assert.ok(!c.hasOwnProperty(m), `${m} removed by detach`);
  }
  assert.equal(c._wickNarrator, undefined, 'controller mark cleared');
  // a detached controller no-ops instead of throwing
  assert.equal(a.walk({}), false);
  assert.deepEqual(a.narrate(), []);
  assert.equal(a.playStory([{}]), false);
  assert.equal(a.getStory(), null);
  // and a fresh attach reinstalls cleanly
  const d = attachNarrator(c);
  assert.notEqual(d, a);
  assert.equal(typeof c.narrate, 'function');
});

test('attachNarrator validates the chart surface', () => {
  assert.throws(() => attachNarrator(null), TypeError);
  assert.throws(() => attachNarrator({}), TypeError, 'no data/range/event surface');
  const noDispatch = narratableChart();
  delete noDispatch.dispatchEvent;
  assert.throws(() => attachNarrator(noDispatch), TypeError);
});

test('additive phase: the core entry still carries its own copies', () => {
  // Until the 2.0 cut (ROADMAP-V2.md), core ships identical methods; the
  // plugin must shadow, never remove. If this fails, the cut landed early.
  for (const m of ['narrate', 'walk', 'stopWalk', 'playRange', 'captureScene', 'getStory', 'playStory', 'stopStory']) {
    assert.equal(typeof WickChart.prototype[m], 'function', `core prototype still has ${m}`);
  }
});

/* ------------------------- narrate ------------------------- */

test('narrate() windows by time and delegates to the analyzer', () => {
  const c = narratableChart();
  attachNarrator(c);
  const whole = c.narrate();
  assert.ok(whole.length > 0);
  const peak = whole.find((e) => e.type === 'pivothigh');
  assert.ok(peak, 'pivot found on the full series');
  const windowed = c.narrate({ from: T(0), to: T(70) });
  assert.ok(windowed.length > 0);
  assert.ok(windowed.every((e) => e.i <= 70), 'windowed events stay inside the range');
  assert.ok(windowed.length < whole.length, 'window is a subset');
  const reversed = c.narrate({ from: T(70), to: T(0) });
  assert.deepEqual(reversed, c.narrate({ from: T(0), to: T(70) }), 'reversed ranges normalize');
  c.data = [];
  assert.deepEqual(c.narrate(), []);
});

/* ------------------------- walk ------------------------- */

test('walk slides the view, announces events, ends exactly once, and can be stopped', async () => {
  const c = narratableChart();
  attachNarrator(c);
  assert.equal(c.walk({ from: 0, to: 199, speed: 5 }), true);
  await new Promise((r) => setTimeout(r, 800));
  const steps = c.events.filter((e) => e.name === 'wick:walk' && e.detail.phase === 'step');
  const ends = c.events.filter((e) => e.name === 'wick:walk' && e.detail.phase === 'end');
  assert.ok(steps.length >= 5, `expected several steps, got ${steps.length}`);
  assert.equal(ends.length, 1, 'exactly one end');
  assert.equal(ends[0].detail.index, 199, 'walk ends at `to`');
  assert.ok(steps.some((s) => s.detail.events.length > 0), 'narrated events announced along the way');
  assert.equal(c._auto, false, 'auto-follow disabled during walk');
  assert.equal(c._view.rightIndex, 199, 'camera parked at the end index');
});

test('walk: false start on empty data; stopWalk fires stop and is idempotent', async () => {
  const c = narratableChart();
  attachNarrator(c);
  c.data = [];
  assert.equal(c.walk({}), false);

  const g = narratableChart();
  attachNarrator(g);
  assert.equal(g.walk({ from: 0, to: 199, speed: 5 }), true);
  await new Promise((r) => setTimeout(r, 15));
  g.stopWalk();
  assert.ok(g.events.some((e) => e.name === 'wick:walk' && e.detail.phase === 'stop'), 'stop phase fired');
  g.stopWalk(); // idempotent, no double event
  assert.equal(g.events.filter((e) => e.name === 'wick:walk' && e.detail.phase === 'stop').length, 1);
});

/* ------------------------- story ------------------------- */

test('playStory applies scenes in order, pans, ends once, and leaves state applied', async () => {
  const c = narratableChart();
  attachNarrator(c);
  const ok = c.playStory(
    [
      { title: 'wide', range: { from: T(0), to: T(99) }, dwell: 500, indicators: 'volume' },
      { title: 'tight', range: { from: T(80), to: T(95) }, dwell: 500, indicators: 'sma:20', scenario: null },
    ],
    { panMs: 100 }
  );
  assert.equal(ok, true);
  await new Promise((r) => setTimeout(r, 1800));
  const scenes = c.events.filter((e) => e.name === 'wick:story' && e.detail.phase === 'scene');
  const ends = c.events.filter((e) => e.name === 'wick:story' && e.detail.phase === 'end');
  assert.deepEqual(scenes.map((s) => s.detail.title), ['wide', 'tight']);
  assert.equal(ends.length, 1);
  assert.equal(c.attrs.indicators, 'sma:20', 'last scene left its indicators applied');
  assert.ok(Math.abs(c._view.rightIndex - 95) < 0.6, `rightIndex ≈ 95 (got ${c._view.rightIndex})`);
  assert.ok(c.getStory().length === 2, 'story remembered for getStory()');
  const copy = c.getStory();
  copy.pop();
  assert.equal(c.getStory().length, 2, 'getStory hands out copies');
});

test('playStory: empty story rejected; stopStory cancels mid-tour', async () => {
  const c = narratableChart();
  attachNarrator(c);
  assert.equal(c.playStory([], {}), false);
  assert.equal(c.playStory([null, 'junk'], {}), false, 'all-invalid scenes → false');

  const g = narratableChart();
  attachNarrator(g);
  g.playStory([{ title: 'slow', range: { from: T(0), to: T(99) }, dwell: 5000 }], { panMs: 400 });
  await new Promise((r) => setTimeout(r, 150));
  g.stopStory();
  const stops = g.events.filter((e) => e.name === 'wick:story' && e.detail.phase === 'stop');
  assert.equal(stops.length, 1);
  g.stopStory(); // idempotent
  assert.equal(g.events.filter((e) => e.name === 'wick:story' && e.detail.phase === 'stop').length, 1);
});

test('captureScene snapshots the public chart state', () => {
  const c = narratableChart();
  attachNarrator(c);
  c.setOverlays([{ type: 'level', price: 150, color: '#26a69a' }]);
  c.setScenario({ horizon: 24 });
  const s = c.captureScene('T'.repeat(100), 'N'.repeat(300));
  assert.equal(s.title.length, 60, 'title clamped');
  assert.equal(s.note.length, 200, 'note clamped');
  assert.deepEqual(s.range, { from: T(50), to: T(199) }, 'visible range captured');
  assert.equal(s.type, 'candles', 'type defaults');
  assert.equal(s.indicators, null, 'no indicators attr → null');
  assert.equal(s.overlays.length, 1, 'overlays captured');
  assert.equal(s.scenario.horizon, 24, 'scenario captured');
  assert.equal(s.riskPlan, undefined, 'absent risk plan stays absent');

  const bare = narratableChart();
  attachNarrator(bare);
  const b = bare.captureScene();
  assert.equal(b.title, '');
  assert.equal(b.overlays, undefined, 'no overlays key when none present');
  assert.equal(b.scenario, undefined);
});

test('_sceneTarget maps times to indices and rejects degenerate ranges', () => {
  const c = narratableChart();
  const t = attachNarrator(c);
  assert.deepEqual(t._sceneTarget({ range: { from: T(10), to: T(30) } }), { i0: 10, i1: 30 });
  assert.deepEqual(t._sceneTarget({ range: { from: T(30), to: T(10) } }), { i0: 10, i1: 30 }, 'reversed normalized');
  assert.equal(t._sceneTarget({ range: { from: T(10), to: T(11) } }), null, '< 2 bars of separation');
  assert.equal(t._sceneTarget({}), null);
});

/* ------------------------- sonification ------------------------- */

test('_maybeSonify: gated by the sonify attribute, one tone per bar, pitched by price', () => {
  const c = narratableChart();
  const t = attachNarrator(c);
  const tones = [];
  t._tone = (freq) => tones.push(freq);
  c._maybeSonify(5); // attribute absent → silent
  assert.equal(tones.length, 0);
  c.attrs.sonify = '';
  c._maybeSonify(5);
  c._maybeSonify(5); // y-only move dedupes
  c._maybeSonify(60);
  assert.equal(tones.length, 2, 'one tone per bar change');
  const bars = c.data;
  const expect = (close) => 180 + (close / 200) * (880 - 180); // linear scale 0..200
  assert.ok(Math.abs(tones[0] - expect(bars[5].close)) < 1e-9, 'pitch follows the y-scale');
  assert.ok(Math.abs(tones[1] - expect(bars[60].close)) < 1e-9);
  c.attrs.sonify = 'false';
  c._maybeSonify(7); // explicit off wins
  assert.equal(tones.length, 2);
});

test('playRange no-ops safely without an AudioContext (SSR / Node)', () => {
  const c = narratableChart();
  attachNarrator(c);
  assert.doesNotThrow(() => c.playRange());
});

/* ------------------------- interruption ------------------------- */

test('_stopPlayback interrupts walk and story from any core input path', async () => {
  const c = narratableChart();
  attachNarrator(c);
  c.walk({ from: 0, to: 199, speed: 5 });
  c.playStory([{ title: 'slow', range: { from: T(0), to: T(99) }, dwell: 5000 }], { panMs: 400 });
  await new Promise((r) => setTimeout(r, 30));
  c._stopPlayback(); // what pointer/wheel/key/double-click call on the element
  const walkStops = c.events.filter((e) => e.name === 'wick:walk' && e.detail.phase === 'stop');
  const storyStops = c.events.filter((e) => e.name === 'wick:story' && e.detail.phase === 'stop');
  assert.equal(walkStops.length, 1, 'walk interrupted');
  assert.equal(storyStops.length, 1, 'story interrupted');
  await new Promise((r) => setTimeout(r, 500));
  const ends = c.events.filter((e) => (e.name === 'wick:walk' || e.name === 'wick:story') && e.detail.phase === 'end');
  assert.equal(ends.length, 0, 'nothing runs to completion after the interrupt');
});

test('detach stops running playback', async () => {
  const c = narratableChart();
  const t = attachNarrator(c);
  c.walk({ from: 0, to: 199, speed: 5 });
  await new Promise((r) => setTimeout(r, 15));
  t.detach();
  await new Promise((r) => setTimeout(r, 100));
  const late = c.events.filter((e) => e.name === 'wick:walk');
  const stepsAtDetach = late.filter((e) => e.detail.phase === 'step').length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(
    c.events.filter((e) => e.name === 'wick:walk' && e.detail.phase === 'step').length,
    stepsAtDetach,
    'no steps after detach'
  );
  assert.equal(c.events.filter((e) => e.name === 'wick:walk' && e.detail.phase === 'end').length, 0);
});

/* ------------------------- component contract ------------------------- */

test('the plugin rides the documented seams, not private re-implementations', () => {
  const src = read('plugins/narrator/narrator.mjs');
  // events are real DOM events on the wick:* channel
  assert.match(src, /CustomEvent\('wick:' \+ name/);
  // the analyzer comes from the shared wickchart core, not a drifted copy
  const core = read('plugins/narrator/core.mjs');
  assert.match(core, /from 'wickchart\/core'/);
  assert.match(core, /calcRSI,/, 'RSI imported from wickchart/core');
  assert.match(core, /detectAnnotations,/, 'the annotation detector imported from wickchart/core');
  // the element contract: camera internals are used, never re-implemented
  assert.match(src, /_clampView\(\)/);
  assert.match(src, /_emitRange\(\)/);
  assert.match(src, /_renderBars/, 'heikin sonifies through the render cache');
  // core keeps its own copies until the 2.0 cut — nothing here edits the class
  assert.ok(!src.includes('WickChart.prototype'), 'the prototype is never touched');
  assert.ok(!src.includes("from 'wickchart'"), 'no element-module import (core primitives only)');
});
