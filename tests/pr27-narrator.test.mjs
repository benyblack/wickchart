// PR #27 — bar-walk narrator: narrate() timeline + walk() replay player.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const { narrateWindow } = await import('../src/core.js');
const { WickChart } = await import('../src/wick-chart.js');

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
  // sorted by index, every event carries its bar time
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

/* ------------------------- walk player ------------------------- */

function walkableChart() {
  const events = [];
  return {
    events,
    _connected: true,
    _walkTimer: 0,
    _data: storyBars(),
    _view: { rightIndex: 199, spacing: 4 },
    _ly: { plotRight: 400 },
    _auto: true,
    _clampView() {},
    _invalidate() {},
    _emitRange() {},
    _fire(name, detail) { events.push({ name, detail }); },
    stopWalk: WickChart.prototype.stopWalk, // walk() calls this.stopWalk internally
  };
}

const call = (fake, m, ...a) => WickChart.prototype[m].call(fake, ...a);

test('walk slides the view, announces events, ends exactly once, and can be stopped', async () => {
  const f = walkableChart();
  assert.equal(call(f, 'walk', { from: 0, to: 199, speed: 5 }), true);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(f._walkTimer, 0, 'timer cleared at the end');
  const steps = f.events.filter((e) => e.name === 'walk' && e.detail.phase === 'step');
  const ends = f.events.filter((e) => e.name === 'walk' && e.detail.phase === 'end');
  assert.ok(steps.length >= 5, `expected several steps, got ${steps.length}`);
  assert.equal(ends.length, 1, 'exactly one end');
  assert.equal(ends[0].detail.index, 199, 'walk ends at `to`');
  assert.ok(steps.some((s) => s.detail.events.length > 0), 'narrated events announced along the way');
  assert.equal(f._auto, false, 'auto-follow disabled during walk');
});

test('walk: false start on empty data; stopWalk fires stop and is idempotent', async () => {
  const f = walkableChart();
  f._data = [];
  assert.equal(call(f, 'walk', {}), false);

  const g = walkableChart();
  assert.equal(call(g, 'walk', { from: 0, to: 199, speed: 5 }), true);
  await new Promise((r) => setTimeout(r, 15));
  assert.notEqual(g._walkTimer, 0, 'walk running');
  call(g, 'stopWalk');
  assert.equal(g._walkTimer, 0);
  assert.ok(g.events.some((e) => e.name === 'walk' && e.detail.phase === 'stop'), 'stop phase fired');
  call(g, 'stopWalk'); // idempotent, no double event
  assert.equal(g.events.filter((e) => e.name === 'walk' && e.detail.phase === 'stop').length, 1);
});

/* ------------------------- component contract ------------------------- */

test('narrator is wired into the chart: narrate(), walk(), stopWalk(), interruption', () => {
  const src = read('src/wick-chart.js');
  assert.match(src, /narrate\(range\) \{/);
  assert.match(src, /narrateWindow\(d, i0, i1\)/, 'narrate() delegates to the core analyzer');
  assert.match(src, /walk\(opts = \{\}\) \{/);
  assert.match(src, /stopWalk\(silent\) \{/);
  assert.match(src, /_fire\('walk', \{ phase: 'step'/);
  assert.match(src, /_fire\('walk', \{ phase: 'end'/);
  assert.match(src, /_fire\('walk', \{ phase: 'stop'/);
  // every interaction entry point interrupts playback (walk + story)
  const pd = src.slice(src.indexOf('_pointerDown(e) {'), src.indexOf('_pointerDown(e) {') + 260);
  assert.match(pd, /_stopPlayback\(\)/, 'pointerdown interrupts');
  const wh = src.slice(src.indexOf('_wheel(e) {'), src.indexOf('_wheel(e) {') + 260);
  assert.match(wh, /_stopPlayback\(\)/, 'wheel interrupts');
  const kd = src.slice(src.indexOf('_keydown(e) {'), src.indexOf('_keydown(e) {') + 260);
  assert.match(kd, /_stopPlayback\(\)/, 'keys interrupt');
  const sp = src.slice(src.indexOf('_stopPlayback() {'), src.indexOf('_stopPlayback() {') + 160);
  assert.match(sp, /stopWalk\(\)/, 'playback stop includes the walk');
  assert.match(sp, /stopStory\(\)/, 'playback stop includes the story');
  const dc = src.slice(src.indexOf('disconnectedCallback() {'), src.indexOf('disconnectedCallback() {') + 400);
  assert.match(dc, /this\.stopWalk\(true\)/, 'disconnect cleans the timer');
});

test('the plugins hub covers the narrator: API, event, interruption, live playground', () => {
  const hub = read('plugins.html');
  const sec = hub.slice(hub.indexOf('id="narrator"'), hub.indexOf('id="coview"'));
  assert.ok(sec.length > 1500, 'narrator coverage is substantive');
  for (const s of ['narrate', 'walk', 'stopWalk', 'wick:walk', 'legPct', 'speed', 'step']) {
    assert.ok(sec.includes(s), `"${s}" missing from the hub narrator section`);
  }
  assert.ok(hub.includes('href="#narrator"'), 'hub TOC links the section');
  assert.ok(read('README.md').includes('Bar-walk narrator'), 'README documents the narrator');
});
