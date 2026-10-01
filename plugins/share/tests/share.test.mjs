// wickchart-share — the standalone builder, the parser, the escaping rules
// and the attach surface. Pure Node: buildStandaloneHTML and parseChartFile
// are plain string/data functions; the browser flow (fetch, blob, download)
// is covered by e2e/share.spec.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStandaloneHTML, parseChartFile, attachShare } from '../share.mjs';

const EVIL = '</script><b>not part of the template</b>';
const BARS = Array.from({ length: 12 }, (_, i) => ({
  time: 1_700_000_000_000 + i * 60_000,
  open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i, volume: 50 + i,
}));
const STATE = { type: 'candles', theme: 'dark', indicators: 'sma:20', view: { from: BARS[0].time, to: BARS[5].time } };

const fakeSources = (evil = '') => ({
  coreSrc: `export const A = 1;${evil}`,
  chartSrc: `import { A } from './core.js'; customElements.define('wick-chart', class {});${evil}`,
});

test('buildStandaloneHTML: emits exactly the template script blocks', () => {
  const html = buildStandaloneHTML({ ...fakeSources(), bars: BARS, state: STATE, meta: { title: 't' } });
  // payload + bootstrap — nothing else may open or close a script block
  assert.equal((html.match(/<script/g) || []).length, 2);
  assert.equal((html.match(/<\/script>/g) || []).length, 2);
  assert.match(html, /<!doctype html>/);
  assert.match(html, /id="wc-share-payload"/);
});

test('buildStandaloneHTML: injected "</script>" cannot break out — in sources, title or bars', () => {
  const html = buildStandaloneHTML({
    ...fakeSources(EVIL),
    bars: BARS.map((b, i) => (i === 0 ? { ...b, volume: EVIL.length } : b)),
    state: STATE,
    meta: { title: `chart${EVIL}` },
  });
  assert.equal((html.match(/<\/script>/g) || []).length, 2, 'no extra closers');
  assert.ok(!html.includes('<b>not part'), 'the injected markup stays inert');
  // the title is HTML-escaped where it renders as markup
  assert.ok(html.includes('chart&lt;'), 'title is escaped in the footer');
});

test('buildStandaloneHTML ↔ parseChartFile round-trip', () => {
  const html = buildStandaloneHTML({
    ...fakeSources(),
    bars: BARS,
    state: STATE,
    meta: { title: 'BTC · 1h', exported: '2026-10-01T00:00:00Z' },
  });
  const back = parseChartFile(html);
  assert.deepEqual(back.bars, BARS);
  assert.deepEqual(back.state, STATE);
  assert.equal(back.meta.title, 'BTC · 1h');
  assert.equal(back.meta.exported, '2026-10-01T00:00:00Z');
});

test('buildStandaloneHTML: rejects unusable inputs loudly', () => {
  assert.throws(() => buildStandaloneHTML({ ...fakeSources(), bars: [] }), /bars are required/);
  const chartSrc = "import { A } from './core.mjs';"; // bundled/rewritten import
  assert.throws(
    () => buildStandaloneHTML({ coreSrc: 'export const A = 1;', chartSrc, bars: BARS }),
    /no longer contains.*'\.\/core\.js'/,
  );
});

test('buildStandaloneHTML: the chart module is rewritten onto the core data URL', () => {
  const html = buildStandaloneHTML({ ...fakeSources(), bars: BARS });
  // the bootstrap replaces the literal import line and imports the result
  assert.match(html, /CHART_SRC\.replace\("from '\.\/core\.js'"/);
  assert.match(html, /await import\(chartUrl\)/);
  assert.match(html, /el\.setState\(state\)/);
  assert.match(html, /el\.setData\(bars\)/);
});

test('parseChartFile: rejects foreign files and unknown payload versions', () => {
  assert.throws(() => parseChartFile('<html><body>no chart here</body></html>'), /no payload block/);
  assert.throws(
    () => parseChartFile('<script id="wc-share-payload" type="application/json">{"v":99,"bars":[]}</script>'),
    /unsupported payload version 99/,
  );
  assert.throws(
    () => parseChartFile('<script id="wc-share-payload" type="application/json">{"v":1,"state":{}}</script>'),
    /no bars/,
  );
});

test('attachShare: installs the methods, exportChart builds from explicit sources, detach removes', async () => {
  const got = { state: null };
  const chart = {
    _data: BARS,
    setData() {},
    get data() { return this._data; },
    getState() { return STATE; },
    getAttribute() { return 'BTC · 1h'; },
    set exportChart(fn) { got.exportChart = fn; },
    get exportChart() { return got.exportChart; },
    set downloadChart(fn) { got.downloadChart = fn; },
    get downloadChart() { return got.downloadChart; },
  };
  const share = attachShare(chart);
  assert.equal(typeof chart.exportChart, 'function');
  const html = await chart.exportChart({ sources: fakeSources() });
  const back = parseChartFile(html);
  assert.deepEqual(back.bars, BARS);
  assert.deepEqual(back.state, STATE);
  assert.equal(back.meta.label, 'BTC · 1h');
  share.detach();
  assert.equal(chart.exportChart, undefined, 'exportChart removed from the element');
  assert.equal(chart.downloadChart, undefined, 'downloadChart removed from the element');
});

test('attachShare: requires a real chart element', () => {
  assert.throws(() => attachShare(null), /chart element is required/);
  assert.throws(() => attachShare({}), /chart element is required/);
});
