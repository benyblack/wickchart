import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildColumns } from '../src/core.js';

const bars = Array.from({ length: 20 }, (_, i) => ({
  time: i * 3600e3,
  open: 10 + i,
  high: 12 + i,
  low: 8 + i,
  close: 11 + i,
  volume: 2,
}));

test('buildColumns aggregates min/max/first/last/sum per pixel column', () => {
  // 20 bars mapped to x = i/2 → 2 bars per column, 10 columns (x 0..9)
  const cols = buildColumns(bars, 0, 19, (i) => i / 2, 10);
  assert.equal(cols.length, 10);
  const c0 = cols[0];
  assert.equal(c0.i0, 0);
  assert.equal(c0.i1, 1);
  assert.equal(c0.open, 10); // first bar's open
  assert.equal(c0.close, 12); // last bar's close in column
  assert.equal(c0.high, 13); // max of highs (12,13)
  assert.equal(c0.low, 8); // min of lows (8,9)
  assert.equal(c0.volume, 4); // summed
  assert.equal(cols[9].i0, 18);
  assert.equal(cols[9].i1, 19);
});

test('buildColumns clamps out-of-range x into the plot', () => {
  // all bars map beyond plotRight → single clamped column
  const cols = buildColumns(bars.slice(0, 5), 0, 4, () => 999, 100);
  assert.equal(cols.length, 1);
  assert.equal(cols[0].x, 99);
  assert.equal(cols[0].i1, 4);
  // all bars left of the plot → clamped to 0
  const left = buildColumns(bars.slice(0, 5), 0, 4, () => -3, 100);
  assert.equal(left.length, 1);
  assert.equal(left[0].x, 0);
});

test('buildColumns keeps x ascending and skips empty columns', () => {
  // bars 0-2 cluster near x=0, bars 17-19 near x=2.4, nothing between
  const idx = [0, 1, 2, 17, 18, 19];
  const subset = idx.map((i) => bars[i]);
  const cols = buildColumns(subset, 0, subset.length - 1, (i) => subset[i].time / 3600e3 / 8, 25);
  assert.equal(cols.length, 2);
  assert.deepEqual(cols.map((c) => c.x), [0, 2]);
  assert.deepEqual(cols.map((c) => c.i1), [2, 5]);
  assert.ok(cols[0].high < cols[1].low); // ascending price series → no overlap
});

test('buildColumns single bar per column keeps identity values', () => {
  const cols = buildColumns(bars.slice(0, 3), 0, 2, (i) => i, 10);
  assert.equal(cols.length, 3);
  for (let k = 0; k < 3; k++) {
    assert.equal(cols[k].open, cols[k].high - 2);
    assert.equal(cols[k].i0, cols[k].i1);
  }
});

test('buildColumns tracks close extremes — a mid-column spike survives for line charts', () => {
  // three bars in one pixel column; the middle close is an outlier spike
  const spike = [
    { time: 0, open: 10, high: 10.5, low: 9.5, close: 10, volume: 1 },
    { time: 1, open: 10, high: 50, low: 9.5, close: 42, volume: 1 },
    { time: 2, open: 10, high: 10.5, low: 9.5, close: 10.2, volume: 1 },
  ];
  const cols = buildColumns(spike, 0, 2, () => 5, 100);
  assert.equal(cols.length, 1);
  const c = cols[0];
  assert.equal(c.close, 10.2); // last close — what a line chart used to plot
  assert.equal(c.cMin, 10); // min close
  assert.equal(c.cMax, 42); // the spike: gone before, visible on the polyline now
  assert.equal(c.high, 50); // wick extremes unchanged for candle mode
  assert.equal(c.low, 9.5);
});
