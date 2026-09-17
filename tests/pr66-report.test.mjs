// PR #66 — the branded snapshot/report export: pure model coverage. The
// canvas composition itself is browser-only and covered by e2e/report.spec.mjs;
// here everything data-shaped is pinned: formatting, layout arithmetic,
// range→index resolution, color theming, option validation and precedence.
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  reportModel, reportColors, luminance, compact, pct, decimalsFor, indexForTime,
} = await import('../src/report.js');

const bars = Array.from({ length: 300 }, (_, i) => ({
  time: 1_700_000_000_000 + i * 3600e3,
  open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000 + i * 10,
}));

/** A duck chart exposing only the public API reportModel reads. */
function makeChart(over = {}) {
  return {
    nodeType: 1,
    data: bars,
    clientWidth: 900,
    clientHeight: 420,
    getVisibleRange: () => ({ from: bars[50].time, to: bars[249].time }),
    exportPNG: () => 'data:image/png;base64,x',
    getAttribute: () => 'BTC · 1h',
    ...over,
  };
}

/* ----------------------------- formatters ----------------------------- */

test('compact, pct and decimalsFor format for the stat grid', () => {
  assert.equal(compact(1234), '1234');
  assert.equal(compact(15000), '15.0k');
  assert.equal(compact(1234567), '1.23M');
  assert.equal(compact(2.5e9), '2.50B');
  assert.equal(compact(NaN), '—');
  assert.equal(pct(12.3456), '+12.35%');
  assert.equal(pct(-4), '-4.00%');
  assert.equal(pct(0), '0.00%');
  assert.equal(decimalsFor(64250), 2);
  assert.equal(decimalsFor(0.000123), 6);
  assert.equal(decimalsFor(0), 2);
});

test('indexForTime resolves the visible window without scanning', () => {
  assert.equal(indexForTime(bars, bars[0].time), 0);
  assert.equal(indexForTime(bars, bars[249].time), 249);
  assert.equal(indexForTime(bars, bars[299].time), 299);
  assert.equal(indexForTime(bars, bars[0].time - 1), 0, 'before the tape clamps to 0');
  // between bars rounds DOWN to the earlier bar, like the chart's own axis
  assert.equal(indexForTime(bars, bars[100].time + 1800e3), 100);
});

/* ------------------------------ the model ------------------------------ */

test('reportModel builds rows from the visible range and the layout adds up', () => {
  const m = reportModel(makeChart());
  assert.equal(m.title, 'BTC · 1h');
  assert.equal(m.width, 900);
  assert.equal(m.height, 64 + 420 + 104 + 40, 'header + chart + stats + footer');
  assert.equal(m.scale, 2, 'default scale');
  assert.equal(m.rows.length, 8, 'the stat grid');
  const labels = m.rows.map((r) => r.label);
  for (const need of ['Return', 'Ann. vol', 'Max drawdown', 'Bars', 'Up / down', 'Avg volume', 'High', 'Low']) {
    assert.ok(labels.includes(need), need + ' row present');
  }
  const ret = m.rows[0];
  assert.equal(ret.color, 'up', 'a positive window is green');
  assert.equal(ret.value, '+132.67%', 'return over closes 150 → 349');
  assert.equal(m.stats.n, 200, 'stats cover exactly the visible bars');
  assert.equal(m.rows[3].value, '200');
});

test('title precedence: opts > label attribute > default; scale clamps', () => {
  assert.equal(reportModel(makeChart(), { title: 'Custom' }).title, 'Custom');
  assert.equal(reportModel(makeChart({ getAttribute: () => null })).title, 'WickChart');
  assert.equal(reportModel(makeChart(), { scale: 9 }).scale, 4);
  assert.equal(reportModel(makeChart(), { scale: 0 }).scale, 2, 'nonsense scale falls back to the default');
  assert.equal(reportModel(makeChart(), { scale: 3 }).scale, 3);
});

test('a down window colors the return row red', () => {
  const falling = bars.map((b, i) => ({ ...b, close: 400 - i }));
  const m = reportModel(makeChart({ data: falling }));
  assert.equal(m.rows[0].color, 'down');
  assert.ok(m.rows[0].value.startsWith('-'));
});

test('empty or unrendered charts refuse with a clear message', () => {
  assert.throws(() => reportModel({ data: [] }), /2\+ bars/);
  assert.throws(() => reportModel({ data: bars, getVisibleRange: () => null }), /rendered view/);
  assert.throws(() => reportModel(null), /2\+ bars/);
});

test('exportReport refuses outside a browser instead of half-working', async () => {
  const { exportReport } = await import('../src/report.js');
  await assert.rejects(() => exportReport(makeChart()), /requires a browser/);
});

/* ------------------------------ colors ------------------------------ */

test('luminance classifies chart backgrounds', () => {
  assert.ok(luminance('#0d1117') < 0.5, 'the dark chart bg is dark');
  assert.ok(luminance('#ffffff') > 0.5);
  assert.ok(luminance('#f4f6f9') > 0.5);
  assert.equal(luminance('rgb(1,2,3)'), 0, 'non-hex reads as dark (fallback)');
});

test('reportColors: explicit themes, and auto follows the chart CSS', () => {
  const dark = reportColors(makeChart(), 'dark');
  assert.equal(dark.bg, '#0d1117');
  assert.equal(dark.panel, '#11141c');
  const light = reportColors(makeChart(), 'light');
  assert.equal(light.bg, '#ffffff');
  assert.equal(light.panel, '#f4f6f9');
  // in Node (no getComputedStyle) auto is the dark palette
  const auto = reportColors(makeChart(), 'auto');
  assert.equal(auto.bg, '#0d1117');
  assert.equal(auto.panel, '#11141c');
  assert.equal(auto.light, false);
});
