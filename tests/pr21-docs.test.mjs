// PR #21 — comprehensive docs page (docs.html): coverage guard.
// The docs must document the component's FULL public surface — this test
// reads the source of truth (src/wick-chart.js) and fails when something
// public is missing from docs.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const docs = read('docs.html');
const hub = read('plugins.html');
// The 2.0 split's plugin-surface attributes / methods / events (moved to
// the plugins hub; core keeps identical copies until the 2.0 cut):
const PLUGIN_ATTRS = ['co-view', 'co-view-name', 'sonify'];
const PLUGIN_METHODS = [
  'setScenario', 'clearScenario', 'setRiskPlan', 'clearRiskPlan',
  'getPeers', 'narrate', 'walk', 'stopWalk', 'playRange',
  'captureScene', 'getStory', 'playStory', 'stopStory',
  'aiTools', 'aiPrompt', 'aiContext', 'applyAI', 'ask',
];
const PLUGIN_EVENTS = ['walk', 'story', 'peers'];

test('docs page ships and is wired into the site, landing, and README', () => {
  assert.ok(docs.includes('<section id="start">'), 'getting-started section present');
  assert.ok(docs.includes('Documentation</title>'), 'page title set');
  const pages = read('.github/workflows/pages.yml');
  assert.ok(pages.includes('docs.html'), 'Pages workflow copies docs.html into the site');
  const landing = read('index.html');
  assert.ok(landing.includes('href="./docs.html"'), 'landing nav links the docs');
  const readme = read('README.md');
  assert.ok(readme.includes('wickchart/docs.html'), 'README links the docs page');
});

test('every observed attribute is documented', () => {
  const src = read('src/wick-chart.js');
  const m = src.match(/static get observedAttributes\(\)\s*\{\s*return\s*\[([^\]]*)\]/);
  assert.ok(m, 'observedAttributes found in source');
  const attrs = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(attrs.length >= 13, `expected the full attribute list, got ${attrs.length}`);
  for (const a of attrs) {
    const where = PLUGIN_ATTRS.includes(a) ? hub : docs;
    const page = PLUGIN_ATTRS.includes(a) ? 'plugins.html' : 'docs.html';
    assert.ok(where.includes(a), `attribute "${a}" missing from ${page}`);
  }
});

test('every public method is documented', () => {
  const methods = [
    'setData', 'update', 'clearData', 'setSeries', 'clearSeries', 'fit', 'getVisibleRange', 'setVisibleRange',
    'exportPNG', 'getDataWindow', 'getState', 'setState',
    'addPosition', 'removePosition', 'clearPositions',
    'addAlert', 'removeAlert', 'clearAlerts',
    'setOverlays', 'addOverlay', 'removeOverlay', 'clearOverlays',
    'clearBrush', 'brushSelection',
    'addLayer', 'removeLayer', 'requestDraw',
    'timeToX', 'xToTime', 'priceToY', 'yToPrice',
    'registerIndicator', 'onloadmore',
  ];
  for (const m of methods) {
    assert.ok(docs.includes(m), `method "${m}" missing from docs.html`);
  }
  for (const m of PLUGIN_METHODS) {
    assert.ok(hub.includes(m), `plugin method "${m}" missing from plugins.html`);
  }
});

test('every chart event is documented', () => {
  const src = read('src/wick-chart.js');
  const events = [...new Set([...src.matchAll(/_fire\('([a-z]+)'/g)].map((x) => x[1]))];
  assert.ok(events.length >= 6, `expected the event list, got ${events.length}`);
  for (const e of events) {
    const moved = PLUGIN_EVENTS.includes(e);
    const where = moved ? hub : docs;
    const page = moved ? 'plugins.html' : 'docs.html';
    assert.ok(where.includes(`wick:${e}`), `event "wick:${e}" missing from ${page}`);
  }
  assert.ok(docs.includes('wick-feed:status'), 'feed status event documented');
});

test('server-side overlays are fully documented (the newest feature)', () => {
  const sec = docs.slice(docs.indexOf('id="overlays"'), docs.indexOf('id="trading"'));
  assert.ok(sec.length > 2000, 'overlays section is substantive');
  // schema fields
  for (const field of ['priceFrom', 'priceTo', 'alpha', 'border', 'dash', 'width', 'label', 'id', 'from', 'to', 'color']) {
    assert.ok(sec.includes(field), `overlay field "${field}" missing`);
  }
  // API surface + attribute + semantics
  for (const api of ['setOverlays', 'addOverlay', 'removeOverlay', 'clearOverlays', 'overlays']) {
    assert.ok(sec.includes(api), `overlays API "${api}" missing`);
  }
  assert.ok(sec.includes('future space'), 'documented that zones extend into future space');
  assert.ok(sec.includes("'[{"), 'declarative JSON attribute example present');
  assert.ok(sec.includes('fetch('), 'server-fetch usage example present');
});

test('WickScript reference lists the built-in functions and caps', () => {
  const sec = docs.slice(docs.indexOf('id="wickscript"'), docs.indexOf('id="volshading"'));
  for (const fn of ['sma', 'ema', 'wma', 'stddev', 'rsi', 'hh', 'll', 'prev', 'change', 'abs', 'sqrt', 'log', 'min', 'max', 'crossup', 'crossdown']) {
    assert.ok(sec.includes(fn), `WickScript function "${fn}" missing`);
  }
  assert.ok(sec.includes('512'), 'expression length cap documented');
  assert.ok(sec.includes('expr:{'), 'expr: syntax documented');
  assert.ok(sec.includes('pexpr:{'), 'pexpr: syntax documented');
});

test('feed attributes are documented', () => {
  const sec = docs.slice(docs.indexOf('id="feeds"'), docs.indexOf('id="events"'));
  for (const a of ['binance', 'demo', 'url', 'poll', 'tf', 'limit', 'live', 'aggregate']) {
    assert.ok(sec.includes(a), `feed attribute "${a}" missing`);
  }
  assert.ok(sec.includes('TickBarAggregator'), 'the aggregate helpers export is documented');
});

test('every sidebar link resolves to a real section', () => {
  const toc = (docs.match(/<ul class="toc"[\s\S]*?<\/ul>/) || [''])[0];
  const ids = [...toc.matchAll(/href="#([^"]+)"/g)].map((x) => x[1]);
  assert.ok(ids.length >= 15, `expected a full table of contents, got ${ids.length}`);
  for (const id of ids) {
    assert.ok(docs.includes(`<section id="${id}"`), `TOC target #${id} has no section`);
  }
});

test('framework bindings are documented with live-demo links', () => {
  assert.ok(docs.includes("'wickchart/react'"), 'React import documented');
  assert.ok(docs.includes('demo/react.html'), 'links the live React demo');
  assert.ok(docs.includes('Vue') && docs.includes('Svelte'), 'Vue and Svelte quickstarts present');
});
