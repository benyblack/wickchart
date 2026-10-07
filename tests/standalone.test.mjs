// Standalone export (wickchart/standalone) — pure coverage: the module
// flattening contract, bar compaction, the payload, the HTML builder and
// the round-trip parse. The load-bearing pin is the real-sources check:
// core.js + flattened wick-chart.js must always concatenate into a module
// that parses — the moment a source edit breaks inlining, this fails.
// The browser-only half (fetch, download, drop, offline open) is covered by
// e2e/standalone.spec.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  flattenModule, escapeScript, embedJson, escapeHtml,
  compactBars, expandBars, payloadFor, buildStandalone,
  exportChart, openShared,
} = await import('../src/standalone.js');

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const CORE = read('src/core.js');
const CHART = read('src/wick-chart.js');

/* --------------------------- flattenModule --------------------------- */

test('flattenModule removes every import form but touches nothing else', () => {
  const src = [
    "import { a, b } from './one.js';",
    "import {\n  c,\n  d,\n} from './two.js';",
    "import def from './three.js';",
    "import * as ns from './four.js';",
    "import './side-effect.js';",
    "import def2, { named } from './five.js';",
    'const keep = a + b + c + d + def + ns.x + named;',
    'export function exported() { return keep; }',
  ].join('\n');
  const out = flattenModule(src);
  assert.equal(out.match(/from '\.\/one\.js'/), null);
  assert.equal(out.match(/side-effect/), null);
  // no import statements survive; the code and export declarations do
  assert.equal(out.match(/^[ \t]*import\b/m), null);
  assert.match(out, /const keep = a \+ b/);
  assert.match(out, /export function exported/);
});

test('flattenModule drops export lists and default bindings, keeps declarations', () => {
  const out = flattenModule([
    'export { WickChart, registerTheme };',
    "export { a, b } from './re.js';",
    'export default class WickChart {}',
    'class Tail {}',
    'export default Tail;',
    'export const VERSION = 1;',
  ].join('\n'));
  assert.equal(out.includes('export {'), false);
  assert.equal(out.includes('export default'), false);
  assert.match(out, /^class WickChart \{\}/m);
  assert.match(out, /^class Tail \{\};?/m);
  assert.match(out, /export const VERSION = 1;/);
});

test('the real sources flatten into one parseable module (the inline contract)', () => {
  const flat = flattenModule(CHART);
  // no import or export-list statements remain anywhere
  for (const line of flat.split('\n')) {
    assert.ok(!/^[ \t]*import[\s({'"]/.test(line), `import survived: ${line}`);
    assert.ok(!/^[ \t]*export\s*\{/.test(line), `export list survived: ${line}`);
  }
  // the shipped </script> example in the header comment must survive as code
  assert.match(flat, /class WickChart extends HTMLElement/);

  // and the concatenation must parse — pinned with node --check, because a
  // syntax slip here only shows up when someone opens an exported file
  const file = join(tmpdir(), `wick-flatten-${process.pid}.mjs`);
  writeFileSync(file, CORE + '\n' + flat);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } finally {
    rmSync(file, { force: true });
  }
});

/* ---------------------------- escaping ---------------------------- */

test('escapeScript neutralizes script-breaking sequences identity-safely', () => {
  assert.equal(escapeScript('x = "</script>";'), 'x = "<\\/script>";');
  assert.equal(escapeScript('a <!-- b'), 'a <\\!-- b');
  // the escapes are identity inside JS strings and comments
  assert.equal(eval('"<\\/script>"'), '</script>');
});

test('embedJson blocks the </script> breakout and escapeHtml the markup', () => {
  const json = embedJson({ label: '</script><script>alert(1)</script>' });
  assert.equal(json.includes('</script>'), false);
  assert.equal(JSON.parse(json).label, '</script><script>alert(1)</script>');
  assert.equal(escapeHtml('a<b>&"c"'), 'a&lt;b&gt;&amp;&quot;c&quot;');
});

/* ------------------------- bars compaction ------------------------- */

const bars = Array.from({ length: 50 }, (_, i) => ({
  time: 1_700_000_000_000 + i * 3600e3,
  open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i,
  volume: i % 7 === 0 ? undefined : 1000 + i,
}));

test('compactBars/expandBars round-trip, dropping and trimming honestly', () => {
  const rows = compactBars(bars);
  assert.equal(rows.length, 50);
  assert.ok(rows.every((r) => r.length === 6 && typeof r[0] === 'number'));
  // missing volume → null → undefined on the way back
  assert.equal(rows[0][5], null);
  const back = expandBars(rows);
  assert.equal(back.length, 50);
  assert.equal(back[0].volume, undefined);
  assert.equal(back[1].volume, 1001);
  assert.deepEqual(
    { time: back[10].time, open: back[10].open, close: back[10].close },
    { time: bars[10].time, open: bars[10].open, close: bars[10].close },
  );

  // maxBars keeps the NEWEST window
  const trimmed = compactBars(bars, 10);
  assert.equal(trimmed.length, 10);
  assert.equal(trimmed[0][0], bars[40].time);

  // non-finite rows are dropped, not exported as poison
  const dirty = compactBars([{ time: null, open: 1, high: 1, low: 1, close: 1 }, bars[0], { ...bars[1], high: NaN }]);
  assert.deepEqual(dirty, [compactBars([bars[0]])[0]]);

  // malformed shared rows throw instead of rendering garbage
  assert.throws(() => expandBars([[1, 2, 3]]), /malformed/);
  assert.throws(() => expandBars([['a', 2, 3, 4, 5]]), /malformed/);
  assert.throws(() => expandBars('no'), /bars array/);
});

/* ----------------------------- payload ----------------------------- */

function makeChart(over = {}) {
  return {
    data: bars,
    getState: () => ({
      type: 'candles', theme: 'dark', indicators: 'sma:20 volume',
      view: { from: bars[10].time, to: bars[40].time },
    }),
    getAttribute: () => 'BTC · 1h',
    ...over,
  };
}

test('payloadFor snapshots state + compact bars, with label baked in', () => {
  const p = payloadFor(makeChart());
  assert.equal(p.wickchart, 1);
  assert.equal(p.label, 'BTC · 1h');
  assert.equal(p.state.label, 'BTC · 1h');
  assert.equal(p.state.indicators, 'sma:20 volume');
  assert.deepEqual(p.state.view, { from: bars[10].time, to: bars[40].time });
  assert.equal(p.bars.length, 50);
  assert.equal(p.theme, undefined, 'built-in themes do not travel');

  assert.equal(payloadFor(makeChart(), { title: 'ETH daily' }).label, 'ETH daily');
  assert.equal(payloadFor(makeChart({ getAttribute: () => null })).label, '');

  assert.throws(() => payloadFor({ data: [], getState: () => ({}), getAttribute: () => '' }), /needs data/);
});

test('payloadFor carries a registered custom theme for exact restorage', async () => {
  const { registerTheme, THEMES } = await import('../src/core.js');
  registerTheme('review-pal', { base: 'light', bg: '#f4f6f9' });
  try {
    const p = payloadFor(makeChart({
      getState: () => ({ type: 'line', theme: 'review-pal' }),
    }));
    assert.equal(p.theme.name, 'review-pal');
    assert.equal(p.theme.palette.bg, '#f4f6f9');
  } finally {
    registerTheme('review-pal', { base: 'dark' }); // restore the registry
  }
});

/* --------------------------- the builder --------------------------- */

test('buildStandalone emits one self-contained page with a safe payload', async () => {
  const payload = payloadFor(makeChart(), { title: 'Break</script>out' });
  const html = buildStandalone({
    payload,
    coreSource: 'export const OK = 1;',
    chartSource: 'export default class WickChart {}\nexport { WickChart };',
    pluginSources: "import { OK } from './core.js';\nexport const USED = OK;",
    init: 'window.__standalone_init_ran = USED;',
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Break&lt;\/script&gt;out · WickChart<\/title>/);
  assert.match(html, /<wick-chart><\/wick-chart>/);
  assert.match(html, /id="wickchart-payload"/);

  // exactly two real closers: the payload script and the module script —
  // everything embedded must be escaped past them
  assert.equal((html.match(/<\/script>/g) || []).length, 2);

  // the payload parses back out (no DOMParser in Node → the regex path)
  const shared = await openShared(html);
  assert.equal(shared.label, 'Break</script>out');
  assert.equal(shared.bars.length, 50);
  assert.equal(shared.state.indicators, 'sma:20 volume');
  assert.deepEqual(shared.state.view, { from: bars[10].time, to: bars[40].time });

  // the module content: imports flattened, plugin seam appended after the
  // bootstrap, init last
  const mod = html.split('<script type="module">')[1].split('</script>')[0];
  assert.equal(/^[ \t]*import/m.test(mod), false);
  assert.ok(mod.indexOf('wickchart-payload') < mod.indexOf('window.__standalone_init_ran'));
  assert.match(mod, /const USED = OK;/);
});

test('buildStandalone themes the host page from the chart, not always dark', async () => {
  const { THEMES } = await import('../src/core.js');
  const dark = buildStandalone({
    payload: payloadFor(makeChart()),
    coreSource: '', chartSource: '',
  });
  assert.match(dark, new RegExp('background:' + THEMES.dark.bg));
  const light = buildStandalone({
    payload: payloadFor(makeChart({ getState: () => ({ type: 'line', theme: 'light' }) })),
    coreSource: '', chartSource: '',
  });
  assert.match(light, new RegExp('background:' + THEMES.light.bg));
});

/* ------------------------- the full pipeline ------------------------- */

test('exportChart works end to end with explicit sources (no fetch needed)', async () => {
  const html = await exportChart(makeChart(), {
    coreSource: 'export const TWO = 2;',
    chartSource: 'class WickChart {}',
    source: 'binance: BTCUSDT',
  });
  assert.match(html, /"source":"binance: BTCUSDT"/);
  const shared = await openShared(html);
  assert.equal(shared.source, 'binance: BTCUSDT');

  const blob = await exportChart(makeChart(), {
    coreSource: 'export const TWO = 2;', chartSource: 'class WickChart {}', as: 'blob',
  });
  assert.equal(blob.type, 'text/html');
  assert.ok((await blob.text()).includes('wickchart-payload'));

  // without explicit sources the module files must be fetchable — in Node
  // (file:// URLs) that fails with the actionable error, not a mystery
  await assert.rejects(
    () => exportChart(makeChart(), {}),
    /could not read the module files/,
  );
});

test('openShared rejects files that are not shared charts', async () => {
  await assert.rejects(() => openShared('<!doctype html><p>just a page</p>'), /not a WickChart shared file/);
  await assert.rejects(() => openShared(42), /File, Blob or HTML string/);
});
