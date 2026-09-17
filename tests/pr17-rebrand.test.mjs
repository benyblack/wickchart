import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import WickChartDefault, { WickChart } from '../src/wick-chart.js';
import WickFeedDefault, { WickFeed } from '../src/wick-feed.js';
import { existsSync } from 'node:fs';

test('renamed modules export the WickChart/WickFeed classes (SSR-safe import)', () => {
  assert.equal(typeof WickChartDefault, 'function');
  assert.equal(WickChartDefault.name, 'WickChart');
  assert.equal(WickChart, WickChartDefault);
  assert.equal(typeof WickFeedDefault, 'function');
  assert.equal(WickFeedDefault.name, 'WickFeed');
  assert.equal(WickFeed, WickFeedDefault);
});

test('indicator registry is module-scoped and shared', () => {
  WickChart.registerIndicator('rebrandtest', {
    kind: 'overlay',
    params: {},
    compute: (bars) => bars.map((b) => b.close),
  });
  assert.ok(WickChart._registry().get('rebrandtest'));
  // a subclass (the deprecated <hab-chart> alias) sees the same registry
  class Alias extends WickChart {}
  assert.ok(Alias._registry().get('rebrandtest'));
  WickChart._registry().delete('rebrandtest');
  assert.equal(Alias._registry().get('rebrandtest'), undefined);
});

test('package manifest points at the renamed files', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // Rebrand shipped in 1.0.0; the manifest must never regress below it.
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  const [major, minor] = pkg.version.split('.').map(Number);
  assert.ok(major > 1 || (major === 1 && minor >= 0), 'version >= 1.0.0');
  assert.equal(pkg.main, 'src/wick-chart.js');
  assert.ok(existsSync(new URL('../' + pkg.main, import.meta.url)));
  for (const sub of ['.', './core', './feed']) {
    const e = pkg.exports[sub];
    assert.ok(e, `exports[${sub}] present`);
    assert.ok(existsSync(new URL('../' + e.default.replace('./', ''), import.meta.url)), `${e.default} exists`);
    assert.match(e.types, /\.d\.ts$/);
  }
  assert.equal(pkg.exports['.'].default, './src/wick-chart.js');
  assert.equal(pkg.exports['./feed'].default, './src/wick-feed.js');
  assert.equal(pkg.exports['.'].types, './types/wick-chart.d.ts');
  assert.equal(pkg.exports['./feed'].types, './types/wick-feed.d.ts');
});

test('source declares the new tags with the 0.x aliases', async () => {
  const src = readFileSync(new URL('../src/wick-chart.js', import.meta.url), 'utf8');
  assert.match(src, /define\('wick-chart', WickChart\)/);
  assert.match(src, /define\('hab-chart'/); // deprecated alias retained
  const feedSrc = readFileSync(new URL('../src/wick-feed.js', import.meta.url), 'utf8');
  assert.match(feedSrc, /define\('wick-feed', WickFeed\)/);
  assert.match(feedSrc, /define\('hab-feed'/);
  assert.match(feedSrc, /querySelector\('wick-chart'\) \|\| document\.querySelector\('hab-chart'\)/);
  // canonical events fire, legacy aliases dispatched alongside
  assert.match(src, /'wick:' \+ name/);
  assert.match(src, /'hab:' \+ name/);
});

test('CSS variables resolve --wick-* first with --hab-* fallback', () => {
  const src = readFileSync(new URL('../src/wick-chart.js', import.meta.url), 'utf8');
  // wick wins outright; the hab read happens only as the fallback (and
  // warns once — pr75). The static stylesheet keeps the same chain.
  assert.match(src, /const v = cs\.getPropertyValue\('--wick-' \+ name\)\.trim\(\);\s*\r?\n\s*if \(v\) return v;/);
  assert.match(src, /const h = cs\.getPropertyValue\('--hab-' \+ name\)\.trim\(\);\s*\r?\n\s*if \(h\) warnDeprecatedAlias/);
  assert.match(src, /var\(--wick-accent, var\(--hab-accent, #4c8dff\)\)/);
});
