// wickchart-paper — controller coverage: replay-event wiring (first event is
// context, increments trade bar-by-bar, backwards seek resets, stop freezes),
// position mirroring onto the chart, wick:paper events, and the equity strip
// render — through a fake chart (the replay tests' idiom).
import test from 'node:test';
import assert from 'node:assert/strict';

const { attachPaper } = await import('../paper.mjs');

const T0 = Date.UTC(2026, 2, 4);
const DT = 3_600_000;
const bars = Array.from({ length: 50 }, (_, i) => ({
  time: T0 + i * DT,
  open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1,
}));

class FakeChart extends EventTarget {
  constructor() {
    super();
    this._d = bars.slice();
    this.layers = [];
    this.events = [];
    this.positions = [];
  }
  get data() {
    return this._d;
  }
  setData(b) {
    this._d = b;
  }
  addLayer(l) {
    this.layers.push(l);
    return l;
  }
  removeLayer(id) {
    this.layers = this.layers.filter((l) => l.id !== id);
  }
  addPosition(p) {
    const at = this.positions.findIndex((x) => x.id === p.id);
    if (at >= 0) this.positions[at] = p;
    else this.positions.push(p);
    return p.id;
  }
  removePosition(id) {
    this.positions = this.positions.filter((p) => p.id !== id);
  }
  requestDraw() {}
  dispatchEvent(e) {
    this.events.push({ type: e.type, detail: e.detail });
    return super.dispatchEvent(e);
  }
}

const fire = (c, detail) => c.dispatchEvent(new CustomEvent('wick:replay', { detail }));
const paperEvs = (c, action) => c.events.filter((e) => e.type === 'wick:paper' && e.detail.action === action);

/** Chart + paper, replay "started" at index 30 (context), ready to trade. */
function fresh() {
  const c = new FakeChart();
  c.setData(bars.slice(0, 31));
  const p = attachPaper(c, { cash: 10000 });
  fire(c, { active: true, index: 30 });
  return { c, p };
}

/* ------------------------- attach / detach ------------------------- */

test('attachPaper requires a chart and docks the equity strip', () => {
  const c = new FakeChart();
  const p = attachPaper(c);
  assert.equal(c.layers.length, 1);
  assert.equal(c.layers[0].id, 'wick-paper');
  assert.ok(c.layers[0].insetBottom >= 24, 'dock height declared');
  assert.throws(() => attachPaper(null), /chart element is required/);
  p.detach();
  assert.equal(c.layers.length, 0);
});

test('the first replay event is context, not trades', () => {
  const { c, p } = fresh();
  assert.equal(p.stats.series.length, 1, 'one seeded equity point at the anchor');
  assert.equal(p.stats.series[0].equity, 10000);
  assert.equal(p.stats.trades, 0);
});

/* ------------------------- fills follow the tape ------------------------- */

test('an order placed at the head fills on the next revealed bar', () => {
  const { c, p } = fresh();
  assert.ok(p.buy(1), 'order accepted');
  assert.equal(paperEvs(c, 'order').length, 1);
  c.setData(bars.slice(0, 32)); // replay reveals bar 31 (price 131)
  fire(c, { active: true, index: 31 });
  assert.deepEqual(p.stats.position, { qty: 1, entry: 131 }, 'filled at the open of bar 31');
  assert.equal(paperEvs(c, 'fill').length, 1);
  assert.equal(p.stats.series.length, 2, 'equity marked at the close');
});

test('the position mirrors onto the chart positions API', () => {
  const { c, p } = fresh();
  p.buy(1);
  c.setData(bars.slice(0, 32));
  fire(c, { active: true, index: 31 });
  assert.equal(c.positions.length, 1);
  assert.deepEqual(c.positions[0], { id: 'wick-paper-position', side: 'long', entry: 131, qty: 1 });
  p.sell(1);
  c.setData(bars.slice(0, 33));
  fire(c, { active: true, index: 32 });
  assert.equal(c.positions.length, 0, 'flat again — entry line removed');
  assert.equal(p.stats.trades, 1);
  assert.equal(paperEvs(c, 'close').length, 1);
});

test('a multi-bar play() run trades every bar in order', () => {
  const { c, p } = fresh();
  p.buy(1);
  for (let i = 32; i <= 40; i++) {
    c.setData(bars.slice(0, i + 1));
    fire(c, { active: true, index: i });
  }
  const s = p.stats;
  assert.equal(s.position.qty, 1);
  // anchored point + bars 31..40 (the skipped 31 is traded on the next event)
  assert.equal(s.series.length, 11);
  // bought at 131 (bar 31's open), marked at 140 (bar 40's close)
  assert.ok(Math.abs(s.series[s.series.length - 1].equity - (10000 + (140 - 131))) < 1e-9);
});

/* ------------------------- resets and freezes ------------------------- */

test('a backwards seek resets the session to the new anchor', () => {
  const { c, p } = fresh();
  p.buy(1);
  c.setData(bars.slice(0, 35));
  fire(c, { active: true, index: 34 });
  assert.equal(p.stats.series.length, 5);
  c.setData(bars.slice(0, 21)); // seek back to index 20
  fire(c, { active: true, index: 20 });
  const s = p.stats;
  assert.equal(s.series.length, 1, 're-seeded');
  assert.equal(s.cash, 10000, 'account restored');
  assert.equal(s.position, null);
  assert.equal(c.positions.length, 0);
  assert.equal(paperEvs(c, 'reset').length, 1);
});

test('replay exit freezes the session readout', () => {
  const { c, p } = fresh();
  p.buy(1);
  c.setData(bars.slice(0, 32));
  fire(c, { active: true, index: 31 });
  const before = p.stats;
  fire(c, { active: false, index: -1 }); // stop()
  assert.deepEqual(p.stats.series, before.series, 'no further trades');
  assert.deepEqual(p.stats.position, before.position, 'the trade stays open on the readout');
});

/* ------------------------- order API passthrough ------------------------- */

test('limits, cancel and flatten drive the engine and fire events', () => {
  const { c, p } = fresh();
  const o = p.buyLimit(95, 1); // below every bar — never touches
  assert.ok(o && o.type === 'limit');
  c.setData(bars.slice(0, 32));
  fire(c, { active: true, index: 31 });
  assert.equal(p.stats.position, null, 'untouched limit stays working');
  assert.equal(p.cancel(o.id), true);
  assert.equal(paperEvs(c, 'cancel').length, 1);

  p.buy(2);
  c.setData(bars.slice(0, 33));
  fire(c, { active: true, index: 32 }); // long 2 @ 132
  p.flatten();
  c.setData(bars.slice(0, 34));
  fire(c, { active: true, index: 33 }); // flat @ 133
  assert.equal(p.stats.position, null);
  assert.equal(p.stats.trades, 1);
  assert.ok(Math.abs(p.stats.realized - 2) < 1e-9);
});

/* ------------------------- the equity strip ------------------------- */

test('the docked strip draws the curve, baseline and readout', () => {
  const { c, p } = fresh();
  p.buy(1);
  for (let i = 32; i <= 36; i++) {
    c.setData(bars.slice(0, i + 1));
    fire(c, { active: true, index: i });
  }
  const lines = [];
  const texts = [];
  const ctx = {
    save() {}, restore() {}, fillRect() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
    arc() {}, setLineDash() {},
    measureText: () => ({ width: 10 }),
    get fillStyle() { return this._f; },
    set fillStyle(v) { this._f = v; texts.push({ style: v }); },
    get strokeStyle() { return this._s; },
    set strokeStyle(v) { this._s = v; lines.push({ style: v }); },
    fillText: (t, x) => texts.push({ text: t, x }),
    font: '', textAlign: '', textBaseline: '',
  };
  c.layers[0].draw({
    ctx,
    layout: { W: 900, plotRight: 880, dock: { y0: 400, h: 44 } },
    palette: { bg: '#000', grid: '#111', up: '#0f0', down: '#f00', text: '#ccc' },
    timeToX: (t) => ((t - T0) / DT) * 18,
  });
  const labels = texts.filter((x) => x.text);
  assert.ok(labels.some((l) => /PAPER · 0 trades/.test(l.text)), 'meta line present');
  assert.ok(lines.some((l) => l.style === '#0f0' || l.style === '#f00'), 'equity line colored');
  // empty session (no draw data) must not throw either
  const c2 = new FakeChart();
  const p2 = attachPaper(c2);
  c2.layers[0].draw({
    ctx,
    layout: { W: 900, plotRight: 880, dock: null },
    palette: { bg: '#000', grid: '#111', up: '#0f0', down: '#f00' },
    timeToX: () => 0,
  });
  p2.detach();
});
