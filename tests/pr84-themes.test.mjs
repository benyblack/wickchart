// PR #84 — registerTheme(): named custom themes over the built-ins, the
// theme-attribute resolver, and report colors for a registered theme.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THEMES, registerTheme, getTheme, resolveThemeName, THEMES_VERSION,
} from '../src/core.js';

const { WickChart } = await import('../src/wick-chart.js');
const P = WickChart.prototype;

test('registerTheme merges a partial palette over the dark base', () => {
  assert.equal(registerTheme('matrix', { bg: '#000000', up: '#22c55e' }), true);
  const m = getTheme('matrix');
  assert.equal(m.bg, '#000000');
  assert.equal(m.up, '#22c55e');
  assert.equal(m.down, THEMES.dark.down);   // inherited
  assert.equal(m.grid, THEMES.dark.grid);   // inherited
});

test('registerTheme drops unknown keys', () => {
  registerTheme('clean', { bg: '#111111', wow: '#ffffff' });
  assert.equal('wow' in getTheme('clean'), false);
});

test('overlay: a single string expands; an array pads with the base colors', () => {
  registerTheme('mono', { overlay: '#cccccc' });
  const o = getTheme('mono').overlay;
  assert.equal(o.length, THEMES.dark.overlay.length);
  assert.ok(o.every((c) => c === '#cccccc'));

  registerTheme('two', { overlay: ['#111111'] });
  const p = getTheme('two').overlay;
  assert.equal(p[0], '#111111');
  assert.equal(p[1], THEMES.dark.overlay[1]);
});

test('volAlpha coerces to a number; garbage falls back to the base value', () => {
  registerTheme('half', { volAlpha: '0.5' });
  assert.equal(getTheme('half').volAlpha, 0.5);
  registerTheme('bad', { volAlpha: 'nope' });
  assert.equal(getTheme('bad').volAlpha, THEMES.dark.volAlpha);
});

test('opts.base selects the merge base', () => {
  registerTheme('sun', { up: '#111111' }, { base: 'light' });
  assert.equal(getTheme('sun').bg, THEMES.light.bg);
});

test('invalid registrations return false and register nothing', () => {
  assert.equal(registerTheme('', {}), false);
  assert.equal(registerTheme('x', null), false);
  assert.equal(getTheme('x'), undefined);
});

test('re-registering overwrites and bumps THEMES_VERSION', () => {
  const v0 = THEMES_VERSION;
  registerTheme('twice', { bg: '#101010' });
  registerTheme('other', {});
  registerTheme('twice', { bg: '#202020' });
  assert.equal(getTheme('twice').bg, '#202020');
  assert.ok(THEMES_VERSION > v0);
});

test('resolveThemeName passes registered names, falls back to dark', () => {
  registerTheme('matrix', {});
  assert.equal(resolveThemeName('matrix'), 'matrix');
  assert.equal(resolveThemeName('light'), 'light');
  assert.equal(resolveThemeName('dark'), 'dark');
  assert.equal(resolveThemeName('nope'), 'dark');
  assert.equal(resolveThemeName(''), 'dark');
  assert.equal(resolveThemeName(null), 'dark');
});

test('prototype keys never resolve — resolveThemeName falls back to dark', () => {
  assert.equal(resolveThemeName('constructor'), 'dark');
  assert.equal(resolveThemeName('toString'), 'dark');
  assert.equal(resolveThemeName(42), 'dark');
});

test('__proto__ and non-string names register nothing', () => {
  assert.equal(registerTheme('__proto__', { bg: '#000000' }), false);
  assert.equal(registerTheme(123, {}), false);
  assert.equal(THEMES.bg, undefined); // prototype not polluted
});

test('an unknown opts.base falls back to dark', () => {
  registerTheme('fb', { up: '#123456' }, { base: 'nope' });
  assert.equal(getTheme('fb').down, THEMES.dark.down);
});

test('re-registering a built-in name replaces it globally', () => {
  const orig = THEMES.light;
  registerTheme('light', { bg: '#f0f0f0' });
  assert.equal(getTheme('light').bg, '#f0f0f0');
  THEMES.light = orig; // restore for the rest of this file's tests
});

test('the main entry re-exports registerTheme', async () => {
  const mod = await import('../src/wick-chart.js');
  assert.equal(typeof mod.registerTheme, 'function');
});

/* ------------------- element wiring (pr56 duck-chart idiom) ------------------- */

test('the theme attribute stores the raw value — no eager coercion', () => {
  registerTheme('matrix', {});
  const chart = { _invalidate() {} };
  chart.attributeChangedCallback = P.attributeChangedCallback.bind(chart);
  chart.attributeChangedCallback('theme', null, 'matrix');
  assert.equal(chart._theme, 'matrix');
  chart.attributeChangedCallback('theme', null, 'nope');
  assert.equal(chart._theme, 'nope', 'an unregistered name stays raw for late registration');
  chart.attributeChangedCallback('theme', null, null);
  assert.equal(chart._theme, 'dark');
});

test('_palette lazily resolves an unregistered name against THEMES.dark', () => {
  const prev = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  try {
    const chart = { _theme: 'nope' };
    chart._palette = P._palette.bind(chart);
    const pal = chart._palette();
    assert.equal(pal.bg, THEMES.dark.bg);
    assert.equal(pal.up, THEMES.dark.up);
  } finally {
    if (prev === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = prev;
  }
});

test('registering the raw name mid-flight invalidates the version-keyed palette', () => {
  const prev = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  try {
    const chart = { _theme: 'nope' };
    chart._palette = P._palette.bind(chart);
    assert.equal(chart._palette().bg, THEMES.dark.bg, 'before registration the dark base shows');
    registerTheme('nope', { bg: '#123123' });
    assert.equal(chart._palette().bg, '#123123', 'the version bump rebuilds from the new registration');
  } finally {
    if (prev === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = prev;
  }
});

/* ------------------- report colors follow the registry ------------------- */

test('reportColors follows a registered theme in auto mode', async () => {
  const { reportColors } = await import('../src/report.js');
  registerTheme('matrix', { bg: '#000000', up: '#22c55e', down: '#ef4444' });
  const pal = reportColors({ nodeType: 1, theme: 'matrix' });
  assert.equal(pal.bg, '#000000');
  assert.equal(pal.up, '#22c55e');
  assert.equal(pal.down, '#ef4444');
  assert.equal(pal.light, false); // luminance('#000000') === 0
});

test('reportColors is unchanged for built-in theme names', async () => {
  const { reportColors } = await import('../src/report.js');
  const pal = reportColors({ nodeType: 1, theme: 'dark' });
  assert.equal(pal.bg, '#0d1117');
  assert.equal(pal.up, '#16c784');
});

test('prototype-key and unregistered names fall back safely in report colors', async () => {
  const { reportColors } = await import('../src/report.js');
  for (const name of ['toString', 'constructor', 'solarized']) {
    const pal = reportColors({ nodeType: 1, theme: name });
    assert.equal(pal.bg, '#0d1117');
    assert.equal(pal.up, '#16c784'); // palette intact, never undefined-corrupted
  }
});

test('a light registered theme keeps its own muted color', async () => {
  const { reportColors } = await import('../src/report.js');
  registerTheme('sun', { bg: '#ffffff', text: '#999999' }, { base: 'light' });
  const pal = reportColors({ nodeType: 1, theme: 'sun' });
  assert.equal(pal.light, true);
  assert.equal(pal.muted, '#999999');   // theme's text, not built-in #6b7280
  assert.equal(pal.panel, '#f4f6f9');   // panel still flips
});

test('_palette guards against prototype-key theme names on the render path', () => {
  const prev = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  try {
    const chart = { _theme: 'toString' };
    chart._palette = P._palette.bind(chart);
    const pal = chart._palette();
    assert.equal(pal.bg, THEMES.dark.bg);
  } finally {
    if (prev === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = prev;
  }
});

test('--wick-* CSS variables override the registered theme', () => {
  registerTheme('cssvar', { bg: '#000000' });
  const prev = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => (n === '--wick-bg' ? '#ffcc00' : '') });
  try {
    const chart = { _theme: 'cssvar' };
    chart._palette = P._palette.bind(chart);
    const pal = chart._palette();
    assert.equal(pal.bg, '#ffcc00');             // the CSS variable wins
    assert.equal(pal.up, getTheme('cssvar').up); // registry value survives underneath
  } finally {
    if (prev === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = prev;
  }
});

test('the shadow chrome is seeded from the resolved theme for keys the page did not declare', () => {
  const prev = globalThis.getComputedStyle;
  // the page declares only --wick-up; everything else must be seeded
  globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => (n === '--wick-up' ? '#deadbe' : '') });
  try {
    registerTheme('chrome', { bg: '#001122' });
    const seeded = {};
    const chart = {
      _theme: 'chrome',
      _wrap: { style: { setProperty: (n, v) => { seeded[n] = v; } } },
    };
    chart._palette = P._palette.bind(chart);
    const pal = chart._palette();
    assert.equal(seeded['--wick-bg'], '#001122');                    // theme value seeded
    assert.equal(seeded['--wick-text-strong'], getTheme('chrome').textStrong);
    assert.equal(pal.up, '#deadbe');                                 // canvas still prefers the declared var
    assert.equal(seeded['--wick-up'], undefined);                    // …and it is never seeded over
    assert.equal(seeded['--wick-vol-alpha'], undefined);             // not a color — never seeded
  } finally {
    if (prev === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = prev;
  }
});
