// PR #31 — plugin layers: external draw hooks + pointer claims + public
// coordinate transforms. The core stays drawing-free; this is the surface a
// drawing toolkit (or any custom marker) builds on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const { WickChart } = await import('../src/wick-chart.js');

const bars = Array.from({ length: 20 }, (_, i) => ({
  time: 1700000000000 + i * 3600e3,
  open: 100 + i,
  close: 100.5 + i,
  high: 101 + i,
  low: 99.5 + i,
  volume: 10 + i,
}));

function makeChart() {
  const c = {
    events: [],
    invalidations: 0,
    _data: bars,
    _pointers: new Map(),
    _pan: null,
    _pinch: null,
    _measuring: false,
    _measure: null,
    _brush: false,
    _brushDrag: null,
    _brushSel: null,
    _layerClaim: null,
    _layers: [],
    _layerSeq: 0,
    _view: { rightIndex: 19, spacing: 10 },
    _ly: { plotRight: 800, main: { y0: 0, y1: 300, h: 300 } },
    _dt: 3600e3,
    _lastScale: { min: 90, max: 130, useLog: false },
    _hover: null,
    _canvas: {
      setPointerCapture() {},
      classList: { add() {}, remove() {} },
    },
    _stopPlayback() {},
    _invalidate() {
      this.invalidations++;
    },
    _localPoint(e) {
      return { x: e.clientX, y: e.clientY };
    },
    _indexForX(x) {
      return this._view.rightIndex - (this._ly.plotRight - x) / this._view.spacing;
    },
    _xFor(i) {
      return this._ly.plotRight - (this._view.rightIndex - i) * this._view.spacing;
    },
    _maybeSonify() {},
    _emitCrosshair() {},
    _emitRange() {},
    _atRight() {
      return false;
    },
    _clampView() {},
    _minSpacing() {
      return 1;
    },
    _updateLegend() {}, // refreshed by the hover hot path (_hoverAt)
    _paintOverlay() {}, // and the crosshair overlay repaint
    _fire(name, detail) {
      this.events.push({ name, detail });
    },
  };
  for (const m of [
    'addLayer',
    'removeLayer',
    'requestDraw',
    'timeToX',
    'xToTime',
    'priceToY',
    'yToPrice',
    '_drawLayers',
    '_layerHit',
    '_routeLayer',
    '_layerPointerEvent',
    '_dockInset',
    '_yToPrice',
    '_hoverAt',
    '_pointerDown',
    '_pointerMove',
    '_pointerUp',
    '_armPress',
    '_disarmPress',
    '_endScrub',
    '_keydown',
  ]) {
    c[m] = WickChart.prototype[m];
  }
  return c;
}

const pev = (x, y, pointerId = 1, extra = {}) => ({
  pointerId,
  button: 0,
  clientX: x,
  clientY: y,
  ...extra,
});

/* ------------------------- registration ------------------------- */

test('addLayer: validates input, auto-ids, replaces same id, caps at 16', () => {
  const c = makeChart();
  assert.equal(c.addLayer(null), null);
  assert.equal(c.addLayer({}), null);
  assert.equal(c.addLayer({ draw: 'nope' }), null);
  const a = c.addLayer({ draw() {} });
  assert.ok(a && a.id === 'layer-1');
  assert.equal(a.onPointer, null, 'non-function onPointer is dropped');
  assert.equal(a.insetBottom, 0, 'no dock space declared by default');
  assert.equal(c.addLayer({ id: 'x', draw() {} }).id, 'x');
  const repl = c.addLayer({ id: 'x', draw() {} });
  assert.equal(c._layers.length, 2, 'same id replaces, does not append');
  assert.equal(c._layers[1], repl);
  for (let i = 0; i < 14; i++) c.addLayer({ draw() {} });
  assert.equal(c._layers.length, 16);
  assert.equal(c.addLayer({ draw() {} }), null, '17th layer rejected');
  assert.ok(c.invalidations >= 17, 'every successful addLayer invalidates');
});

test('insetBottom: clamped at addLayer time; dock inset = max across layers', () => {
  const c = makeChart();
  c.addLayer({ id: 'a', draw() {}, insetBottom: 46 });
  c.addLayer({ id: 'b', draw() {}, insetBottom: 2000 });
  c.addLayer({ id: 'c', draw() {}, insetBottom: -30 });
  c.addLayer({ id: 'd', draw() {}, insetBottom: NaN });
  c.addLayer({ id: 'e', draw() {}, insetBottom: 12.7 });
  assert.equal(c._layers[0].insetBottom, 46);
  assert.equal(c._layers[1].insetBottom, 160, 'clamped to the 160px cap');
  assert.equal(c._layers[2].insetBottom, 0, 'negative → no dock space');
  assert.equal(c._layers[3].insetBottom, 0, 'non-finite → no dock space');
  assert.equal(c._layers[4].insetBottom, 13, 'rounded');
  assert.equal(c._dockInset(), 160, 'the largest declared inset wins');
  c.removeLayer('b');
  assert.equal(c._dockInset(), 46, 'shrink recomputes after removal');
});

test('removeLayer: by handle or id; unknown → false; clears a live claim', () => {
  const c = makeChart();
  const h = c.addLayer({ id: 'lv', draw() {}, onPointer() { return true; } });
  assert.equal(c.removeLayer('nope'), false);
  c._layerClaim = { layer: c._layers[0], pointerId: 1 };
  assert.equal(c.removeLayer(h), true);
  assert.equal(c._layerClaim, null, 'removing the claiming layer releases the claim');
  assert.equal(c.removeLayer('lv'), false);
  assert.ok(c.invalidations >= 1);
});

test('requestDraw is the public repaint hook', () => {
  const c = makeChart();
  const before = c.invalidations;
  c.requestDraw();
  assert.equal(c.invalidations, before + 1);
});

/* ------------------------- draw api ------------------------- */

test('_drawLayers: api shape (ctx/layout/palette/data/view + transforms); a throwing layer is isolated', () => {
  const c = makeChart();
  const seen = [];
  const warns = [];
  const ctx = { save() {}, restore() {} };
  const pal = { accent: '#4c8dff' };
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a);
  try {
    c.addLayer({
      id: 'boom',
      draw() {
        throw new Error('boom');
      },
    });
    c.addLayer({
      id: 'ok',
      draw(api) {
        seen.push(api);
      },
    });
    c._drawLayers(ctx, pal, c._ly, bars);
  } finally {
    console.warn = origWarn;
  }
  assert.equal(seen.length, 1, 'the layer after the throwing one still paints');
  assert.equal(warns.length, 1);
  assert.match(String(warns[0][1]), /boom/);
  const api = seen[0];
  assert.equal(api.ctx, ctx);
  assert.equal(api.palette, pal);
  assert.equal(api.layout, c._ly);
  assert.equal(api.data, bars);
  assert.equal(api.view, c._view);
  // bound transforms work straight off the api object
  assert.ok(Math.abs(api.priceToY(110) - 150) < 1e-9, '110 = mid of [90,130] → mid-height');
  assert.ok(Math.abs(api.timeToX(bars[5].time) - c._xFor(5)) < 1e-9);
});

/* ------------------------- pointer claims ------------------------- */

test('a claiming layer owns the gesture: no pan, gets move/up, modifiers passed', () => {
  const c = makeChart();
  const got = [];
  c.addLayer({
    id: 'grab',
    draw() {},
    onPointer(ev) {
      got.push(ev);
      return ev.type === 'down';
    },
  });
  c._pointerDown(pev(600, 150, 1, { shiftKey: true }));
  assert.ok(c._layerClaim && c._layerClaim.pointerId === 1);
  assert.equal(c._pan, null, 'chart does not start a pan');
  const before = c._view.rightIndex;
  c._pointerMove(pev(300, 160, 1)); // a 300px drag would pan 30 bars otherwise
  assert.equal(c._view.rightIndex, before, 'claimed drag does not pan the chart');
  assert.equal(c._pinch, null);
  c._pointerUp(pev(320, 160, 1));
  assert.equal(c._layerClaim, null);
  assert.equal(c._pointers.size, 0);
  const after = got.filter((e) => e.type !== 'down').length;
  c._pointerMove(pev(310, 160, 1)); // released → hover path, no layer events
  assert.equal(got.filter((e) => e.type !== 'down').length, after);
  assert.deepEqual(
    got.map((e) => e.type),
    ['down', 'move', 'up']
  );
  assert.equal(got[0].shiftKey, true, 'modifiers are forwarded');
  assert.ok(Math.abs(got[0].x - 600) < 1e-9 && Math.abs(got[0].y - 150) < 1e-9);
});

test('layers are asked before pinch/brush/measure/pan; first claim wins', () => {
  const c = makeChart();
  const order = [];
  c.addLayer({
    draw() {},
    onPointer(ev) {
      order.push('a');
      return false;
    },
  });
  c.addLayer({
    draw() {},
    onPointer(ev) {
      order.push('b');
      return ev.type === 'down';
    },
  });
  c._pointerDown(pev(400, 150));
  assert.deepEqual(order, ['a', 'b'], 'asked in registration order');
  assert.equal(c._layerClaim.layer.id, 'layer-2');
  assert.equal(c._pan, null);
});

test('a declining layer leaves normal interaction untouched', () => {
  const c = makeChart();
  const got = [];
  c.addLayer({ draw() {}, onPointer(ev) { got.push(ev.type); return false; } });
  c._pointerDown(pev(400, 150));
  assert.equal(c._layerClaim, null);
  assert.ok(c._pan, 'pan starts as usual');
  const before = c._view.rightIndex;
  c._pointerMove(pev(300, 150));
  assert.ok(c._view.rightIndex > before, 'drag pans the chart');
  assert.deepEqual(got, ['down'], 'no move/up routed without a claim');
});

test('extra pointers are inert while a layer owns a gesture', () => {
  const c = makeChart();
  const got = [];
  c.addLayer({ draw() {}, onPointer(ev) { got.push(ev.type); return ev.type === 'down'; } });
  c._pointerDown(pev(600, 150, 1));
  c._pointerDown(pev(500, 160, 2)); // second finger: no pinch may start
  assert.equal(c._pinch, null);
  const n = got.length;
  c._pointerMove(pev(450, 180, 2)); // not the claiming pointer → ignored
  assert.equal(got.length, n);
  c._pointerUp(pev(450, 180, 2));
  assert.ok(c._layerClaim, 'the original claim survives');
  c._pointerUp(pev(600, 150, 1));
  assert.equal(c._layerClaim, null);
});

test('Escape routes a cancel to the claiming layer and releases it', () => {
  const c = makeChart();
  const got = [];
  c.addLayer({ draw() {}, onPointer(ev) { got.push(ev); return ev.type === 'down'; } });
  c._pointerDown(pev(600, 150, 7));
  c._keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(c._layerClaim, null);
  assert.equal(got.at(-1).type, 'cancel');
  assert.equal(got.at(-1).pointerId, 7);
});

test('pointercancel routes as cancel', () => {
  const c = makeChart();
  const got = [];
  c.addLayer({ draw() {}, onPointer(ev) { got.push(ev.type); return true; } });
  c._pointerDown(pev(600, 150, 1));
  c._pointerUp({ ...pev(600, 150, 1), type: 'pointercancel' });
  assert.equal(got.at(-1), 'cancel');
  assert.equal(c._layerClaim, null);
});

/* ------------------------- transforms ------------------------- */

test('priceToY / yToPrice: linear + log round-trips, null guards', () => {
  const c = makeChart();
  assert.ok(Math.abs(c.priceToY(130) - 0) < 1e-9, 'max → top');
  assert.ok(Math.abs(c.priceToY(90) - 300) < 1e-9, 'min → bottom');
  const y = c.priceToY(112.5);
  assert.ok(Math.abs(c.yToPrice(y) - 112.5) < 1e-9);
  assert.equal(c.priceToY(NaN), null);
  assert.equal(c.priceToY('x'), null);
  assert.equal(c.yToPrice({}), null);
  c._lastScale = { min: Math.log10(100), max: Math.log10(400), useLog: true };
  assert.ok(Math.abs(c.yToPrice(c.priceToY(200)) - 200) < 1e-6, 'log round-trip');
  c._ly = null;
  assert.equal(c.priceToY(100), null);
  assert.equal(c.yToPrice(10), null);
});

test('timeToX: bar times, in-between fraction, future + past extrapolation, seconds input', () => {
  const c = makeChart();
  assert.ok(Math.abs(c.timeToX(bars[5].time) - c._xFor(5)) < 1e-9);
  const mid = (bars[5].time + bars[6].time) / 2;
  assert.ok(Math.abs(c.timeToX(mid) - c._xFor(5.5)) < 1e-9, 'halfway between bars');
  const last = bars.length - 1;
  assert.ok(Math.abs(c.timeToX(bars[last].time) - c._xFor(last)) < 1e-9);
  const future = bars[last].time + 2 * 3600e3;
  assert.ok(Math.abs(c.timeToX(future) - c._xFor(last + 2)) < 1e-9, 'extrapolates 2 bars right');
  const past = bars[0].time - 3600e3;
  assert.ok(Math.abs(c.timeToX(past) - c._xFor(-1)) < 1e-9, 'extrapolates left of history');
  assert.ok(
    Math.abs(c.timeToX(bars[last].time / 1000) - c._xFor(last)) < 1e-9,
    'seconds auto-detected'
  );
  assert.equal(c.timeToX('nope'), null);
  c._ly = null;
  assert.equal(c.timeToX(bars[0].time), null);
});

test('xToTime: inverse of timeToX incl. extrapolation, null guards', () => {
  const c = makeChart();
  const x10 = c._xFor(10);
  assert.equal(c.xToTime(x10), bars[10].time);
  const xm = c._xFor(10.5);
  assert.equal(c.xToTime(xm), (bars[10].time + bars[11].time) / 2, 'fractional between bars');
  const t = bars[19].time + 3.5 * 3600e3;
  assert.ok(Math.abs(c.xToTime(c.timeToX(t)) - t) < 1e-6, 'round-trip through future space');
  assert.ok(Math.abs(c.xToTime(c._xFor(-2)) - (bars[0].time - 2 * 3600e3)) < 1e-6, 'left of data');
  assert.equal(c.xToTime(NaN), null);
  c._ly = null;
  assert.equal(c.xToTime(100), null);
});

/* ------------------------- wiring + docs ------------------------- */

test('layers are painted under the crosshair and asked before every built-in gesture', () => {
  const src = read('src/wick-chart.js');
  const paint = src.indexOf('if (this._layers.length) this._drawLayers(ctx, pal, ly, d);');
  // the crosshair left the main render pass for the offscreen hover layer;
  // _render refreshes that layer last (the no-data early return also clears
  // it — search from the layer paint onward), so ordering semantics hold
  const cross = src.indexOf('this._paintOverlay();', paint);
  const lastPrice = src.indexOf('last price line + pill');
  assert.ok(paint > 0 && lastPrice > 0 && cross > paint, 'layer paint sits after content, before crosshair');
  const pd = src.slice(src.indexOf('_pointerDown(e) {'), src.indexOf('_pointerDown(e) {') + 1500);
  const hitAt = pd.indexOf('_layerHit(e, pt)');
  const pinchAt = pd.indexOf('this._pointers.size === 2');
  const brushAt = pd.indexOf('this._brush && !e.shiftKey');
  assert.ok(hitAt > 0 && hitAt < pinchAt && pinchAt < brushAt, 'claim asked before pinch/brush');
  const dc = src.indexOf('disconnectedCallback() {');
  const dcBlock = src.slice(dc, dc + 400);
  assert.match(dcBlock, /_layerClaim = null/, 'disconnect releases any claim');
});

test('docs + README cover the plugin layer API', () => {
  const docs = read('docs.html');
  const sec = docs.slice(docs.indexOf('id="plugins"'), docs.indexOf('id="perf"'));
  assert.ok(sec.length > 1500, 'plugins section is substantive');
  for (const s of ['addLayer', 'removeLayer', 'onPointer', 'requestDraw', 'timeToX', 'xToTime', 'priceToY', 'yToPrice', 'cancel']) {
    assert.ok(sec.includes(s), `"${s}" missing from the docs section`);
  }
  assert.ok(docs.includes('href="#plugins"'), 'TOC links the section');
  assert.ok(read('README.md').includes('layer'), 'README mentions layers');
});
