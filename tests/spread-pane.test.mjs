// Cross-symbol WickScript: alignSeries (time-aligned aux arrays with NaN
// gaps), aux vars in evalScript (`eth_close`), and the setSeries/
// clearSeries API that feeds them — the core primitive behind a spread
// pane with its own axis (`pexpr:{close - eth_close}`).
// (Named spread-pane at write time; renamed to the prNN convention when
// the batch PR number is known — see docs/decisions/2.1.0-polish-track.md.)
import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../src/core.js');
const { WickChart } = await import('../src/wick-chart.js');
const P = WickChart.prototype;
const { alignSeries, evalScript, compileScript } = core;

const bar = (time, close, extra = {}) => ({
  time, open: close, high: close + 1, low: close - 1, close, volume: 10, ...extra,
});

test('alignSeries maps by timestamp and leaves NaN in the gaps', () => {
  const primary = [bar(100, 1), bar(200, 2), bar(300, 3), bar(400, 4)];
  // aux covers 100 & 300 only, arrives out of order
  const aux = [bar(300, 30), bar(100, 10)];
  const al = alignSeries(primary, aux);
  assert.deepEqual(al.close, [10, NaN, 30, NaN]);
  assert.deepEqual(al.high, [11, NaN, 31, NaN]);
  assert.equal(al.open[0], 10);
  assert.equal(al.volume[2], 10);
  // no aux at all → all NaN; empty primary → empty
  assert.deepEqual(alignSeries(primary, []).close, [NaN, NaN, NaN, NaN]);
  assert.deepEqual(alignSeries([], [bar(1, 1)]).close, []);
});

test('evalScript exposes aux series as name_field variables', () => {
  const primary = [bar(100, 50), bar(200, 51), bar(300, 52)];
  const aux = { eth: [bar(100, 30), bar(300, 31)] };
  const out = evalScript(compileScript('close - eth_close'), primary, aux);
  assert.deepEqual(out, [20, NaN, 21]);
  // ratio form and other fields work the same
  const ratio = evalScript(compileScript('close / eth_close'), primary, aux);
  assert.equal(ratio[0].toFixed(6), (50 / 30).toFixed(6));
  assert.ok(Number.isNaN(ratio[1]));
  const hi = evalScript(compileScript('eth_high'), primary, aux);
  assert.deepEqual(hi, [31, NaN, 32]);
});

test('names are sanitized to identifier-safe variable prefixes', () => {
  const primary = [bar(100, 10)];
  const out = evalScript(
    compileScript('close - btc_usdt_close'),
    primary,
    { 'BTC-USDT': [bar(100, 4)] } // hyphen → underscore
  );
  assert.deepEqual(out, [6]);
});

test('setSeries normalizes, sorts, replaces and clears', () => {
  const chart = {
    _data: [bar(100, 5)],
    _series: null,
    _version: 7,
    _invalidate() { this.dirty = true; },
  };
  chart.setSeries = P.setSeries.bind(chart);
  chart.clearSeries = P.clearSeries.bind(chart);

  chart.setSeries('eth', [bar(300, 31), bar(200, 30)]);
  assert.equal(chart._version, 8);
  assert.deepEqual(chart._series.eth.map((b) => b.close), [30, 31]); // sorted
  assert.ok(chart.dirty);

  chart.setSeries('eth', []); // empty clears
  assert.equal('eth' in chart._series, false);
  assert.equal(chart._version, 9);

  chart.clearSeries('nope'); // unknown name: no version bump
  assert.equal(chart._version, 9);
});
