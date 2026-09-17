// PR #29 — story mode: scenes of chart state played as a narrated tour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const core = await import('../src/core.js');
const { normalizeScene, sceneList, easeInOutCubic } = core;
const { WickChart } = await import('../src/wick-chart.js');

/* ------------------------- core helpers ------------------------- */

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
});

/* ------------------------- playback on a fake ------------------------- */

function fakeChart() {
  const events = [];
  const attrs = {};
  return {
    events, attrs,
    _connected: true,
    _storyToken: 0,
    _story: null,
    _data: Array.from({ length: 100 }, (_, i) => ({
      time: 1700000000000 + i * 3600e3,
      open: 10, high: 11, low: 9, close: 10.5, volume: 100,
    })),
    _view: { rightIndex: 99, spacing: 8 },
    _ly: { plotRight: 400 },
    _auto: true,
    _overlays: [],
    _scenario: null,
    _riskPlan: null,
    _minSpacing() { return 1; },
    _clampView() {},
    _invalidate() {},
    _emitRange() {},
    _fire(name, detail) { events.push({ name, detail }); },
    getAttribute(k) { return attrs[k] ?? null; },
    setAttribute(k, v) { attrs[k] = String(v); },
    get overlays() { return this._overlays; },
    setOverlays(o) { this._overlays = o; },
    get scenario() { return this._scenario; },
    setScenario(s) { this._scenario = s; },
    clearScenario() { this._scenario = null; },
    get riskPlan() { return this._riskPlan; },
    setRiskPlan(p) { this._riskPlan = p; },
    clearRiskPlan() { this._riskPlan = null; },
    getVisibleRange() {
      const d = this._data;
      return { from: d[50].time, to: d[99].time };
    },
    _applyScene: WickChart.prototype._applyScene,
    _sceneTarget: WickChart.prototype._sceneTarget,
    _storyTween: WickChart.prototype._storyTween,
    playStory: WickChart.prototype.playStory,
    stopStory: WickChart.prototype.stopStory,
    getStory: WickChart.prototype.getStory,
    _stopPlayback: WickChart.prototype._stopPlayback,
    stopWalk: WickChart.prototype.stopWalk,
  };
}

const T = (i) => 1700000000000 + i * 3600e3;

test('playStory applies scenes in order, pans, ends once, and leaves state applied', async () => {
  const f = fakeChart();
  const ok = f.playStory(
    [
      { title: 'wide', range: { from: T(0), to: T(99) }, dwell: 500, indicators: 'volume' },
      { title: 'tight', range: { from: T(80), to: T(95) }, dwell: 500, indicators: 'sma:20', scenario: null },
    ],
    { panMs: 100 }
  );
  assert.equal(ok, true);
  await new Promise((r) => setTimeout(r, 1800));
  const scenes = f.events.filter((e) => e.name === 'story' && e.detail.phase === 'scene');
  const ends = f.events.filter((e) => e.name === 'story' && e.detail.phase === 'end');
  assert.deepEqual(scenes.map((s) => s.detail.title), ['wide', 'tight']);
  assert.equal(ends.length, 1);
  // scene 1 applied indicators; scene 2 replaced them; camera ended on the tight range
  assert.equal(f.attrs.indicators, 'sma:20');
  assert.ok(Math.abs(f._view.rightIndex - 95) < 0.6, `rightIndex ≈ 95 (got ${f._view.rightIndex})`);
  assert.ok(f.getStory().length === 2, 'story remembered for getStory()');
});

test('playStory: empty story rejected; stopStory cancels mid-tour', async () => {
  const f = fakeChart();
  assert.equal(f.playStory([], {}), false);
  assert.equal(f.playStory([null, 'junk'], {}), false, 'all-invalid scenes → false');

  const g = fakeChart();
  g.playStory([{ title: 'slow', range: { from: T(0), to: T(99) }, dwell: 5000 }], { panMs: 400 });
  await new Promise((r) => setTimeout(r, 150));
  assert.notEqual(g._storyToken, 0);
  g.stopStory();
  const stops = g.events.filter((e) => e.name === 'story' && e.detail.phase === 'stop');
  assert.equal(stops.length, 1);
  assert.equal(g._storyToken, 0);
  g.stopStory(); // idempotent
  assert.equal(g.events.filter((e) => e.name === 'story' && e.detail.phase === 'stop').length, 1);
});

test('_sceneTarget maps times to indices and rejects degenerate ranges', () => {
  const f = fakeChart();
  const call = (m, ...a) => WickChart.prototype[m].call(f, ...a);
  assert.deepEqual(call('_sceneTarget', { range: { from: T(10), to: T(30) } }), { i0: 10, i1: 30 });
  assert.deepEqual(call('_sceneTarget', { range: { from: T(30), to: T(10) } }), { i0: 10, i1: 30 }, 'reversed order normalized');
  assert.equal(call('_sceneTarget', { range: { from: T(10), to: T(11) } }), null, '< 2 bars of separation');
  assert.equal(call('_sceneTarget', {}), null);
});

/* ------------------------- component contract ------------------------- */

test('story is wired into the chart and interrupted by every input path', () => {
  const src = read('src/wick-chart.js');
  assert.match(src, /captureScene\(title, note\) \{/);
  assert.match(src, /playStory\(story, opts = \{\}\) \{/);
  assert.match(src, /stopStory\(silent\) \{/);
  assert.match(src, /getStory\(\) \{/);
  assert.match(src, /sceneList\(story\)/, 'stories validated through core');
  assert.match(src, /easeInOutCubic\(/, 'camera eased with the core easing');
  for (const anchor of ['_pointerDown(e) {', '_wheel(e) {', '_keydown(e) {', 'this._onDbl = () => {']) {
    const block = src.slice(src.indexOf(anchor), src.indexOf(anchor) + 260);
    assert.match(block, /_stopPlayback\(\)/, `${anchor.trim()} interrupts playback`);
  }
  const dc = src.slice(src.indexOf('disconnectedCallback() {'), src.indexOf('disconnectedCallback() {') + 400);
  assert.match(dc, /stopStory\(true\)/, 'disconnect cleans playback');
});

test('the plugins hub covers story mode: API, event, capture, semantics', () => {
  const hub = read('plugins.html');
  const sec = hub.slice(hub.indexOf('id="narrator"'), hub.indexOf('id="coview"'));
  assert.ok(sec.length > 1500, 'story coverage is substantive');
  for (const s of ['captureScene', 'playStory', 'stopStory', 'getStory', 'wick:story', 'dwell', 'panMs', 'loop']) {
    assert.ok(sec.includes(s), `"${s}" missing from the hub narrator section`);
  }
  assert.ok(hub.includes('href="#narrator"'), 'hub TOC links the section');
  assert.ok(read('README.md').includes('Story mode'), 'README documents story mode');
});
