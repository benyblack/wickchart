// PR #17 (inverted at 2.0) — the rebrand is complete: the 0.x hab-* names
// are GONE from the source. During 1.x this file proved the aliases kept
// working; at the 2.0 cut it flips to proving nothing remains.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const chartMod = await import('../src/wick-chart.js');
const feedMod = await import('../src/wick-feed.js');
const { WickChart } = chartMod;

test('renamed modules export the WickChart/WickFeed classes (SSR-safe import)', () => {
  assert.equal(typeof chartMod.default, 'function');
  assert.equal(chartMod.default.name, 'WickChart');
  assert.equal(WickChart, chartMod.default);
  assert.equal(typeof feedMod.default, 'function');
  assert.equal(feedMod.default.name, 'WickFeed');
  assert.equal(feedMod.WickFeed, feedMod.default);
});

test('indicator registry is module-scoped and shared', () => {
  WickChart.registerIndicator('rebrandtest', {
    kind: 'overlay',
    params: {},
    compute: (bars) => bars.map((b) => b.close),
  });
  assert.ok(WickChart._registry().get('rebrandtest'));
  class Sub extends WickChart {}
  assert.ok(Sub._registry().get('rebrandtest'));
  WickChart._registry().delete('rebrandtest');
  assert.equal(Sub._registry().get('rebrandtest'), undefined);
});

test('no hab- alias remains anywhere in src/ (the 2.0 cut)', () => {
  for (const f of ['src/core.js', 'src/wick-chart.js', 'src/wick-feed.js', 'src/report.js', 'src/worker.js', 'src/worker-core.js']) {
    const src = read(f);
    assert.ok(!src.includes('hab-'), `${f} still references a hab- alias`);
    assert.ok(!src.includes("'hab:"), `${f} still dispatches hab: events`);
    assert.ok(!src.includes('"hab:'), `${f} still dispatches hab: events`);
    assert.ok(!src.includes('HabChart') && !src.includes('HabFeed'), `${f} still defines an alias class`);
  }
});

test('the stylesheet themes with --wick-* only', () => {
  const src = read('src/wick-chart.js');
  assert.ok(src.includes('var(--wick-'), 'canonical vars present');
  assert.ok(!src.includes('--hab-'), 'no --hab-* fallbacks remain');
});

test('only the wick-chart / wick-feed elements register', () => {
  const chart = read('src/wick-chart.js');
  const feed = read('src/wick-feed.js');
  assert.match(chart, /customElements\.define\('wick-chart', WickChart\)/);
  assert.doesNotMatch(chart, /customElements\.define\('hab-chart'/);
  assert.match(feed, /customElements\.define\('wick-feed', WickFeed\)/);
  assert.doesNotMatch(feed, /customElements\.define\('hab-feed'/);
});
