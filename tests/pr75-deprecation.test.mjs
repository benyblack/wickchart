// PR #75 — 1.7.1 deprecation warnings for the 0.x hab-* aliases: every
// alias surface warns exactly once per process, the wick-* canonical path
// never warns, and the warns name the 2.0 replacement. The alias code
// itself still works until the 2.0 cut (pr17-rebrand keeps proving that).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* jsdom first, so the element modules register against a real registry —
 * the pr18 mount pattern (globals installed before the dynamic import). */
const warns = [];
const realWarn = console.warn;
console.warn = (msg) => warns.push(String(msg));

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'https://wickchart.test/',
});
const g = globalThis;
const KEYS = ['window', 'document', 'navigator', 'HTMLElement', 'customElements', 'CustomEvent', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
const saved = KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]);
const setGlobal = (k, v) => Object.defineProperty(g, k, { value: v, writable: true, configurable: true });
setGlobal('window', dom.window);
setGlobal('document', dom.window.document);
setGlobal('navigator', dom.window.navigator);
setGlobal('HTMLElement', dom.window.HTMLElement);
setGlobal('customElements', dom.window.customElements);
setGlobal('CustomEvent', dom.window.CustomEvent);
setGlobal('MutationObserver', dom.window.MutationObserver);
setGlobal('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
setGlobal('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));

const { WickChart } = await import('../src/wick-chart.js');
const { WickFeed } = await import('../src/wick-feed.js');
const { warnDeprecatedAlias } = await import('../src/core.js');

const restore = () => {
  console.warn = realWarn;
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d);
    else delete g[k];
  }
};

test('canonical wick-* usage never warns', () => {
  const before = warns.length;
  // element creation + a plain wick: event are fully canonical…
  const c = document.createElement('wick-chart');
  const f = document.createElement('wick-feed');
  c.dispatchEvent(new CustomEvent('wick:range'));
  assert.equal(warns.length, before, 'creating and driving the canonical elements is silent');
  // …while the internal _fire helper still fans out to the hab: alias
  // (asserted separately below — driving it here would warn by design)
  assert.ok(f);
});

test('every hab-* alias surface warns exactly once, naming the replacement', async () => {
  const before = warns.length;

  // 1 — the <hab-chart> element
  document.createElement('hab-chart');
  document.createElement('hab-chart'); // second instance stays silent

  // 2 — hab:* chart events: still fired by _fire, warned only when listened to
  const c = document.createElement('wick-chart');
  const seen = [];
  let firedWarns = warns.length;
  c._fire('range', { from: 1, to: 2 });
  c._fire('range', { from: 3, to: 4 });
  assert.equal(warns.length, firedWarns, 'firing the alias channel alone is silent — canonical apps never see it');
  c.addEventListener('hab:range', (e) => seen.push(e.type)); // <- the warn
  c._fire('range', { from: 5, to: 6 });
  assert.deepEqual(seen, ['hab:range'], 'the alias event reaches its listener');
  c.addEventListener('hab:range', () => {}); // second listener stays silent
  assert.equal(warns.length, firedWarns + 1);

  // 3 — the <hab-feed> element
  document.createElement('hab-feed');

  // 4 — hab-feed:* events: warned when listened to
  const f = document.createElement('wick-feed');
  f.addEventListener('hab-feed:status', () => {});
  f.addEventListener('hab-feed:status', () => {});

  // 5 — a --hab-* variable actually consumed by the palette
  const gcs = globalThis.getComputedStyle; // jsdom's (returns empty values)
  setGlobal('getComputedStyle', () => ({ getPropertyValue: (n) => (n.startsWith('--hab-') ? '#123456' : '') }));
  c._pal = null; // drop the palette cache
  const pal = c._palette();
  setGlobal('getComputedStyle', gcs);
  assert.equal(pal.up, '#123456', 'the --hab-* value was honored (with a warn)');

  const fired = warns.slice(before);
  const expected = [
    'wickchart: <hab-chart> is removed in 2.0 — use <wick-chart>',
    'wickchart: hab:* events are removed in 2.0 — listen for wick:*',
    'wickchart: <hab-feed> is removed in 2.0 — use <wick-feed>',
    'wickchart: hab-feed:* events are removed in 2.0 — listen for wick-feed:*',
    'wickchart: --hab-* variables are removed in 2.0 — rename to --wick-*',
  ];
  assert.deepEqual(fired.sort(), [...expected].sort(), 'exactly the five alias surfaces warned');
  assert.equal(new Set(fired).size, fired.length, 'each exactly once');

  // everything re-triggered stays silent
  const quiet = warns.length;
  document.createElement('hab-chart');
  c._fire('range', {});
  c.addEventListener('hab:range', () => {});
  WickFeed.prototype._fire.call(f, 'status', {});
  f.addEventListener('hab-feed:status', () => {});
  c._pal = null;
  c._palette();
  assert.equal(warns.length, quiet, 'warn-once holds across all surfaces');
});

test('warnDeprecatedAlias is the single, exported helper', () => {
  assert.equal(typeof warnDeprecatedAlias, 'function');
  const before = warns.length;
  warnDeprecatedAlias('kitchen sink alias'); // dedupe key is the message
  warnDeprecatedAlias('kitchen sink alias');
  assert.deepEqual(warns.slice(before), ['wickchart: kitchen sink alias']);
});

test('every alias site routes through the helper (source contract)', () => {
  const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const chart = read('src/wick-chart.js');
  const feed = read('src/wick-feed.js');
  const core = read('src/core.js');
  for (const src of [chart, feed]) {
    const habEvents = [...src.matchAll(/dispatchEvent\(new CustomEvent\('hab:/g)].length;
    const warnsNear = [...src.matchAll(/warnDeprecatedAlias\(/g)].length;
    assert.ok(warnsNear >= 2, 'each element module warns at its alias sites');
    assert.ok(habEvents <= 2, 'the alias dispatch sites are the two known channels');
  }
  assert.match(core, /export function warnDeprecatedAlias/, 'the helper lives in core, shared by both elements');
  // the static stylesheet fallbacks are pure CSS — documented, not warnable
  assert.ok(chart.includes('var(--wick-') || chart.includes('--wick-'), 'canonical vars present');
});

/* Globals stay installed for the process lifetime (each test file runs in
 * its own process); nothing after this file observes them. */
