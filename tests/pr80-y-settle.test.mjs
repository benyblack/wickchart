// Y-range settle policy — the vertical twin of the axis-width settle
// (PR #78). A live feed re-fit the price range on every render: overlays
// track the forming close both ways and each new bar slides the window,
// so the whole chart breathed vertically on high-frequency pairs. The
// settled range expands the violated side at once, contracts only to a
// range the data has occupied under 90% of for a sustained 750ms, and
// user/scale-input changes snap to a fresh tight fit.
// PR #80 — the 2.1 polish track.
import test from 'node:test';
import assert from 'node:assert/strict';

const { WickChart } = await import('../src/wick-chart.js');
const P = WickChart.prototype;

// deterministic clock (node:test gives this file its own process)
const realNow = performance.now.bind(performance);
let clock = 0;
performance.now = () => clock;

const fresh = () => P._settleRange.bind({ _ySettle: null, _yNarrow: null });

test('first observation fits tightly', () => {
  const w = fresh();
  assert.deepEqual(w(10, 20), [10, 20]);
});

test('a new extreme expands the violated side only, at once', () => {
  const w = fresh();
  w(10, 20);
  assert.deepEqual(w(10, 25), [10, 25]); // high escape: immediate
  assert.deepEqual(w(7, 25), [7, 25]); // low escape: immediate
  assert.deepEqual(w(8, 24), [7, 25]); // inside: unchanged
});

test('contraction requires a sustained 750ms hold under 90% usage', () => {
  const w = fresh();
  w(10, 20);
  clock += 100;
  assert.deepEqual(w(11, 18), [10, 20]); // inside the debounce window
  clock += 200;
  assert.deepEqual(w(11, 18), [10, 20]); // still short of 750ms total
  clock += 600;
  assert.deepEqual(w(11, 18), [11, 18]); // held: adopt
});

test('usage within 10% of the settled width never contracts', () => {
  const w = fresh();
  w(10, 20);
  clock += 60_000;
  // 9.5..19.5 uses 100%… 10.5..19.5 uses 90% — exactly at the line keeps;
  // well-within-but-not-under-90% keeps too
  assert.deepEqual(w(10.05, 19.95), [10, 20]);
  assert.deepEqual(w(10.5, 19.5), [10, 20]);
});

test('oscillating inputs never contract the range', () => {
  const w = fresh();
  w(10, 20);
  // an overlay tracking the forming close, both directions, past the
  // debounce window each time — each distinct candidate restarts the timer
  for (let k = 0; k < 5; k++) {
    clock += 500;
    assert.deepEqual(w(11, 18), [10, 20]);
    clock += 500;
    assert.deepEqual(w(10.2, 19.8), [10, 20]);
  }
});

test('a y-snap drops the settle — the next observation fits tightly', () => {
  const c = { _ySettle: null, _yNarrow: null };
  const w = P._settleRange.bind(c);
  w(10, 25);
  c._ySettle = c._yNarrow = null; // the inlined y-snap (see _wheel/_applyFit/…)
  assert.deepEqual(w(12, 18), [12, 18]);
});

/* ---- through _mainScale: the settled range drives rawMin/rawHi ---- */

function scaleChart(bars, type = 'line') {
  const c = {
    _renderBars: () => bars,
    _type: type,
    _log: false,
    _ind: { overlays: [] },
    _indicatorSeries: () => ({ lines: [] }),
    _ySettle: null,
    _yNarrow: null,
  };
  c._settleRange = P._settleRange.bind(c);
  return c;
}
const bar = (close) => ({ time: close * 1000, open: close, high: close, low: close, close, volume: 1 });

test('_mainScale reports the settled extremes as rawMin/rawHi', () => {
  const c = scaleChart([bar(10), bar(20)]);
  const ms = P._mainScale.bind(c);
  let s = ms(0, 1, null);
  assert.equal(s.rawMin, 10);
  assert.equal(s.rawHi, 20);
  // forming tick escapes upward: rawHi expands, rawMin holds → the price
  // axis and gridlines stay put on the low side
  c._renderBars = () => [bar(10), bar(23)];
  clock += 50;
  s = ms(0, 1, null);
  assert.equal(s.rawMin, 10);
  assert.equal(s.rawHi, 23);
  // quiet contraction: the first quiet frame records the candidate, the
  // hold adopts it on a later qualifying frame
  c._renderBars = () => [bar(12), bar(17)];
  ms(0, 1, null);
  clock += 800;
  s = ms(0, 1, null);
  assert.equal(s.rawMin, 12);
  assert.equal(s.rawHi, 17);
});

test('clock restored for the rest of the process', () => {
  performance.now = realNow;
  assert.equal(typeof realNow(), 'number');
});
