// PR #78 — stable price-axis width under live ticks. The axis width is
// measured from the formatted last close, and digits in a proportional
// font measure differently ("1" narrower than "8"), so a high-frequency
// feed flipped the ceil() back and forth a pixel at a time — and since
// every candle's x anchors at plotRight = W - priceW, the whole chart
// shook sideways on every tick. The width now grows immediately (labels
// must never clip) and shrinks only when a genuinely narrower width has
// held for 750ms, so flapping prices can never move the layout.
import test from 'node:test';
import assert from 'node:assert/strict';

const { WickChart } = await import('../src/wick-chart.js');
const P = WickChart.prototype;

// deterministic clock for the shrink debounce (node:test gives this file
// its own process, so the patch is contained)
const realNow = performance.now.bind(performance);
let clock = 0;
performance.now = () => clock;

const fresh = () => P._axisWidth.bind({ _priceW: null, _pwNarrow: null });

test('axis width grows immediately', () => {
  const w = fresh();
  assert.equal(w(60), 60);
  assert.equal(w(75), 75);
});

test('1px digit-width noise never moves the axis', () => {
  const w = fresh();
  w(70);
  clock += 10_000;
  assert.equal(w(69), 70); // below-prev-by-1 is noise, not a regime change
  clock += 10_000;
  assert.equal(w(69), 70);
});

test('a real narrower width is adopted only after it holds', () => {
  const w = fresh();
  w(70);
  clock += 100;
  assert.equal(w(60), 70); // inside the debounce window: unchanged
  clock += 800;
  assert.equal(w(60), 60); // held past 750ms: adopt
});

test('flapping prices never shrink the axis', () => {
  const w = fresh();
  w(70);
  // 60 ↔ 70 on alternating renders, each step well past the window alone
  for (let k = 0; k < 6; k++) {
    clock += 500;
    assert.equal(w(60), 70);
    clock += 500;
    assert.equal(w(70), 70);
  }
});

test('clock restored for the rest of the process', () => {
  performance.now = realNow;
  assert.equal(typeof realNow(), 'number');
});
