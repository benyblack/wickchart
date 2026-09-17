// PR #75 (rewritten at the 2.0 cut) — the hab-* alias warnings left with
// the aliases; what remains is the moved-method contract: without a
// package attached, every moved method is a warn-once stub naming its
// package, and attaching the package replaces it with the real thing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { WickChart } = await import('../src/wick-chart.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const warns = [];
const realWarn = console.warn;
console.warn = (msg) => warns.push(String(msg));

const MOVED = [
  ['narrate', 'wickchart-narrator'],
  ['walk', 'wickchart-narrator'],
  ['stopWalk', 'wickchart-narrator'],
  ['playRange', 'wickchart-narrator'],
  ['captureScene', 'wickchart-narrator'],
  ['getStory', 'wickchart-narrator'],
  ['playStory', 'wickchart-narrator'],
  ['stopStory', 'wickchart-narrator'],
  ['getPeers', 'wickchart-coview'],
  ['setScenario', 'wickchart-scenario'],
  ['clearScenario', 'wickchart-scenario'],
  ['setRiskPlan', 'wickchart-scenario'],
  ['clearRiskPlan', 'wickchart-scenario'],
  ['aiTools', 'wickchart-ai'],
  ['aiPrompt', 'wickchart-ai'],
  ['aiContext', 'wickchart-ai'],
  ['applyAI', 'wickchart-ai'],
  ['ask', 'wickchart-ai'],
];

test('every moved method is a warn-once stub naming its package', () => {
  const fake = { constructor: WickChart };
  for (const [name, pkg] of MOVED) {
    const fn = WickChart.prototype[name];
    assert.equal(typeof fn, 'function', `${name} still exists as a stub`);
    const before = warns.length;
    const r = fn.call(fake);
    assert.equal(r, undefined, `${name} no-ops`);
    fn.call(fake); // second call stays silent
    assert.deepEqual(warns.slice(before), [`wickchart: ${name}() moved to the ${pkg} package in 2.0`]);
  }
});

test('attaching a package shadows its stubs (spot check via the source)', () => {
  // the stubs sit on the prototype; every attachX installs own properties
  // that shadow them (asserted per-package in the plugin test suites).
  // Here: the stub loop is generated from one table — single source.
  const src = read('src/wick-chart.js');
  assert.match(src, /\['narrate', 'wickchart-narrator'\]/, 'the moved-methods table exists');
  assert.match(src, /WickChart\.prototype\[name\] = function/, 'stubs generated on the prototype');
  assert.match(src, /warnDeprecatedAlias\(/, 'they warn through the shared helper');
});

test('the scenario/riskPlan accessors read the plugin seams', () => {
  const fake = Object.create(WickChart.prototype);
  fake._scenario = { horizon: 12, path: [{ h: 1, price: 10 }] };
  fake._riskPlan = { entry: 100, stop: 99, levels: [{ k: 1, price: 101 }] };
  assert.equal(fake.scenario.horizon, 12);
  assert.equal(fake.riskPlan.levels.length, 1);
  assert.equal(Object.create(WickChart.prototype).scenario, null, 'no scenario → null');
  assert.equal(Object.create(WickChart.prototype).riskPlan, null);
});

test('warnDeprecatedAlias is still the shared once-only helper (stubs use it)', async (t) => {
  const { warnDeprecatedAlias } = await import('../src/core.js');
  const before = warns.length;
  warnDeprecatedAlias('cut-check message');
  warnDeprecatedAlias('cut-check message');
  assert.deepEqual(warns.slice(before), ['wickchart: cut-check message']);
  // console.warn stays patched for the process lifetime (each test file
  // runs in its own process); nothing after this file observes it.
  void t;
});
