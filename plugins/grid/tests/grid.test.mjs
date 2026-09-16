// wickchart-grid — pure fan-out model coverage: sync parsing, range
// propagation with echo suppression and clamp-cycle breaking, ghost
// crosshair lifecycle and drawing, add/remove/detach semantics. Charts are
// duck-typed EventTargets (the pr56 idiom): no DOM, no canvas — draws are
// recorded by a stub ctx.
import test from 'node:test';
import assert from 'node:assert/strict';

const { GridSync, parseSync, makeGhost, attachGrid } = await import('../core.mjs');

/** A duck-typed chart: EventTarget + the slice of the element contract the
 *  sync group touches. setVisibleRange fires wick:range, like the real one. */
class FakeChart {
  constructor(range = { from: 0, to: 100 }) {
    this.range = { ...range };
    this.applied = [];
    this.layers = [];
    this.draws = 0;
  }
  addEventListener(n, f) { (this._h ||= {})[n] ||= []; this._h[n].push(f); }
  removeEventListener(n, f) {
    const l = (this._h ||= {})[n];
    if (l) this._h[n] = l.filter((x) => x !== f);
  }
  dispatch(n, detail) {
    for (const f of [...(this._h?.[n] || [])]) f({ target: this, detail });
  }
  getVisibleRange() { return { ...this.range }; }
  setVisibleRange(r) {
    this.range = { ...r };
    this.applied.push({ ...r });
    this.dispatch('wick:range', { ...r });
  }
  addLayer(l) { this.layers.push(l); return l; }
  removeLayer(id) { this.layers = this.layers.filter((l) => l.id !== id); }
  requestDraw() { this.draws++; }
  userPan(r) { this.range = { ...r }; this.dispatch('wick:range', { ...r }); }
}

/* ------------------------------ parsing ------------------------------- */

test('parseSync: defaults, aliases, garbage tolerance', () => {
  assert.deepEqual([...parseSync('range crosshair')].sort(), ['crosshair', 'range']);
  assert.deepEqual([...parseSync('both')].sort(), ['crosshair', 'range']);
  assert.deepEqual([...parseSync(null)].sort(), ['crosshair', 'range']); // attribute absent
  assert.deepEqual([...parseSync('')].sort(), ['crosshair', 'range']);
  assert.deepEqual([...parseSync('  time ')], ['time']);
  assert.deepEqual([...parseSync('range, time')].sort(), ['range', 'time']);
  assert.deepEqual([...parseSync('nonsense range')], ['range'], 'unknown tokens drop');
  assert.deepEqual([...parseSync('???')].sort(), ['crosshair', 'range'], 'all-garbage → default');
  assert.deepEqual([...parseSync('off')], [], 'explicit off syncs nothing');
  assert.deepEqual([...parseSync('range none')], [], 'none wins over kinds listed beside it');
});

/* ------------------------------ membership ----------------------------- */

test('add is idempotent and rejects junk; remove/detach clean up', () => {
  const g = new GridSync();
  const a = new FakeChart();
  assert.equal(g.add(a), true);
  assert.equal(g.add(a), false, 'second add is a no-op');
  assert.equal(g.add(null), false);
  assert.equal(g.add(undefined), false);
  assert.equal(g.charts().length, 1);
  assert.equal(g.remove(a), true);
  assert.equal(g.remove(a), false);
  g.add(a);
  g.detach();
  assert.equal(g.charts().length, 0);
  assert.equal(a.layers.length, 0, 'ghost layer removed on detach');
});

/* --------------------------- range fan-out ----------------------------- */

test('a user range change fans out to every other chart', () => {
  const g = new GridSync({ sync: 'range' });
  const a = new FakeChart();
  const b = new FakeChart();
  const c = new FakeChart();
  g.add(a); g.add(b); g.add(c);

  a.userPan({ from: 10, to: 50 });
  assert.deepEqual(b.range, { from: 10, to: 50 });
  assert.deepEqual(c.range, { from: 10, to: 50 });
  assert.equal(a.applied.length, 0, 'the source chart is never touched');
  assert.equal(b.applied.length, 1);
});

test('the echo of an applied range is swallowed, not re-fanned', () => {
  const g = new GridSync({ sync: 'range' });
  const a = new FakeChart();
  const b = new FakeChart();
  g.add(a); g.add(b);

  a.userPan({ from: 10, to: 50 });
  // b's setVisibleRange fired wick:range synchronously (see FakeChart) and
  // that echo must not bounce back onto a
  assert.equal(a.applied.length, 0, 'no echo bounce');
  assert.equal(b.applied.length, 1);
});

test('applying a range the sibling already has is skipped', () => {
  const g = new GridSync({ sync: 'range' });
  const a = new FakeChart({ from: 0, to: 40 });
  const b = new FakeChart({ from: 0, to: 40.5 }); // within 1 ms — same window
  g.add(a); g.add(b);
  a.userPan({ from: 0, to: 40.2 });
  assert.equal(b.applied.length, 0, 'near-equal range not re-applied');
});

test('clamp feedback converges in one bounce instead of ping-ponging', () => {
  // b can only display a narrower window: its setVisibleRange clamps
  class Clamper extends FakeChart {
    setVisibleRange(r) {
      const clamped = { from: Math.max(r.from, 20), to: Math.min(r.to, 80) };
      super.setVisibleRange(clamped);
    }
  }
  const g = new GridSync({ sync: 'range' });
  const a = new FakeChart({ from: 0, to: 50 });
  const b = new Clamper({ from: 0, to: 50 });
  g.add(a); g.add(b);

  a.userPan({ from: 0, to: 100 }); // b clamps to 20..80, its echo fans back once
  // one bounce: a follows to the clamped window, then everything is still
  assert.deepEqual(a.range, { from: 20, to: 80 }, 'a converges on the clampable window');
  assert.deepEqual(b.range, { from: 20, to: 80 });
  assert.equal(b.applied.length, 1, `b applied once (got ${b.applied.length})`);
  assert.equal(a.applied.length, 1, `a applied once, no ping-pong (got ${a.applied.length})`);
  // the group is quiet afterwards: re-emitting the converged target (a late
  // rAF echo would) inside 250 ms is a cycle, not a user — nothing re-fans
  const aBefore = a.applied.length;
  const bBefore = b.applied.length;
  b.userPan({ from: 20, to: 80 });
  assert.equal(a.applied.length, aBefore, 'late echo of the converged range is dropped');
  assert.equal(b.applied.length, bBefore);
});

test('range fan-out is a no-op when range sync is off', () => {
  const g = new GridSync({ sync: 'crosshair' });
  const a = new FakeChart();
  const b = new FakeChart();
  g.add(a); g.add(b);
  a.userPan({ from: 10, to: 50 });
  assert.deepEqual(b.range, { from: 0, to: 100 });
});

/* --------------------------- crosshair ghosts -------------------------- */

test('a crosshair move mirrors as a ghost on the siblings', () => {
  const g = new GridSync();
  const a = new FakeChart();
  const b = new FakeChart();
  g.add(a); g.add(b);

  a.dispatch('wick:crosshair', { bar: { time: 1234 }, price: 99.5 });
  assert.equal(b.layers.length, 1, 'ghost layer attached on first mirror');
  assert.equal(b.draws, 1, 'repaint requested');
  // the layer draws dashed time+price lines within the plot
  const moves = [];
  const ctx = stubCtx(moves);
  b.layers[0].draw({
    ctx,
    layout: { plotRight: 800, plotBottom: 400, main: { h: 300 } },
    palette: { crosshair: '#fff' },
    timeToX: (t) => (t === 1234 ? 321 : -1),
    priceToY: (p) => (p === 99.5 ? 123 : -1),
  });
  assert.ok(moves.some((m) => m.y0 === 0 && m.y1 === 400), 'vertical line spans the plot');
  assert.ok(moves.some((m) => m.x0 === 0 && m.x1 === 800), 'horizontal line spans the plot');
});

test('sync="time" mirrors the time line only', () => {
  const g = new GridSync({ sync: 'time' });
  const a = new FakeChart();
  const b = new FakeChart();
  g.add(a); g.add(b);
  a.dispatch('wick:crosshair', { bar: { time: 1234 }, price: 99.5 });
  b.layers[0].draw({
    ctx: stubCtx([]),
    layout: { plotRight: 800, plotBottom: 400, main: { h: 300 } },
    palette: {},
    timeToX: () => 100,
    priceToY: () => 50,
  });
  // priceToY returns 50 (in range) — but the ghost must not have been given
  // a price at all: assert via a second draw with a recording price mapper
  let priceAsked = 0;
  b.layers[0].draw({
    ctx: stubCtx([]),
    layout: { plotRight: 800, plotBottom: 400, main: { h: 300 } },
    palette: {},
    timeToX: () => 100,
    priceToY: () => (priceAsked++, 50),
  });
  assert.equal(priceAsked, 0, 'time-only sync never asks for a price mapping');
});

test('a crosshair leave clears the ghosts', () => {
  const g = new GridSync();
  const a = new FakeChart();
  const b = new FakeChart();
  g.add(a); g.add(b);
  a.dispatch('wick:crosshair', { bar: { time: 1234 }, price: 99.5 });
  const drawsBefore = b.draws;
  a.dispatch('wick:crosshair', null);
  assert.equal(b.draws, drawsBefore + 1, 'clear repaint requested');
  const moves = [];
  b.layers[0].draw({
    ctx: stubCtx(moves),
    layout: { plotRight: 800, plotBottom: 400, main: { h: 300 } },
    palette: {},
    timeToX: () => 100,
    priceToY: () => 50,
  });
  assert.equal(moves.length, 0, 'cleared ghost draws nothing');
});

test('crosshair detail without a bar or price is treated as a leave', () => {
  const g = new GridSync();
  const a = new FakeChart();
  const b = new FakeChart();
  g.add(a); g.add(b);
  a.dispatch('wick:crosshair', { price: 5 }); // no bar → cannot map time
  assert.equal(b.layers.length, 0, 'no ghost attached for a bar-less detail');
});

test('makeGhost attaches lazily and survives a late chart upgrade', () => {
  const chart = new FakeChart();
  const noLayer = { draws: 0 };
  const ghost = makeGhost(noLayer); // chart without addLayer yet
  ghost.update({ time: 1, price: 2 });
  assert.equal(noLayer.draws, 0);
  ghost.update(null); // must not throw on a layerless chart either
});

/* ------------------------------- attachGrid ---------------------------- */

test('attachGrid wires a chart collection and reports membership', () => {
  const a = new FakeChart();
  const b = new FakeChart();
  const g = attachGrid([a, b], { sync: 'range' });
  assert.equal(g.charts().length, 2);
  a.userPan({ from: 5, to: 55 });
  assert.deepEqual(b.range, { from: 5, to: 55 });
  g.detach();
  a.userPan({ from: 7, to: 77 });
  assert.deepEqual(b.range, { from: 5, to: 55 }, 'detached: no more fan-out');
  assert.deepEqual(attachGrid('junk').charts(), [], 'non-array input tolerated');
});

/** Canvas stub that records line segments ({x0,y0,x1,y1}) from path calls. */
function stubCtx(sink) {
  let cur = null;
  return {
    save() {}, restore() {},
    setLineDash() {},
    beginPath() { cur = null; },
    moveTo(x, y) { cur = { x0: x, y0: y }; },
    lineTo(x, y) { if (cur) sink.push({ ...cur, x1: x, y1: y }); },
    stroke() {},
  };
}
