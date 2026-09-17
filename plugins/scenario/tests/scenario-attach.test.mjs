// wickchart-scenario — the attach layer: the four planning methods
// installed on the instance, state written to the documented seams the
// element's renderer, cone cache, future-space reservation and accessors
// already read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { attachScenario } from '../scenario.mjs';
const { WickChart } = await import('../../../src/wick-chart.js');

const read = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');

/** Duck chart with the element's scenario surface: the state seams plus
 *  accessor copies of the prototype getters (which read the same seams). */
function plannableChart() {
  const c = {
    invalidations: 0,
    _scenario: null,
    _riskPlan: null,
    _invalidate() { this.invalidations++; },
    get scenario() {
      return this._scenario ? { ...this._scenario, path: this._scenario.path.map((p) => ({ ...p })) } : null;
    },
    get riskPlan() {
      return this._riskPlan ? { ...this._riskPlan, levels: this._riskPlan.levels.map((l) => ({ ...l })) } : null;
    },
  };
  return c;
}

/* ------------------------- attach / validation ------------------------- */

test('attachScenario validates, installs the four methods, is idempotent', () => {
  assert.throws(() => attachScenario(null), TypeError);
  assert.throws(() => attachScenario({}), TypeError, 'no _invalidate seam');
  const c = plannableChart();
  const a = attachScenario(c);
  assert.equal(attachScenario(c), a, 'second attach returns the same controller');
  for (const m of ['setScenario', 'clearScenario', 'setRiskPlan', 'clearRiskPlan']) {
    assert.ok(c.hasOwnProperty(m), `${m} installed as an own property`);
  }
});

test('additive phase: the core element still carries its own methods', () => {
  for (const m of ['setScenario', 'clearScenario', 'setRiskPlan', 'clearRiskPlan']) {
    assert.equal(typeof WickChart.prototype[m], 'function', `core prototype still has ${m}`);
  }
});

/* ------------------------- scenario ------------------------- */

test('setScenario validates, stores on the seam, invalidates, returns the normalized spec', () => {
  const c = plannableChart();
  attachScenario(c);
  const s = c.setScenario({ path: [100, 110, 120], label: 'bull' });
  assert.equal(s, c._scenario, 'the normalized spec is the stored one');
  assert.deepEqual(c._scenario.path.map((p) => p.price), [100, 110, 120]);
  assert.ok(c.invalidations >= 1, 'setter repaints');
  assert.equal(c.scenario.path.length, 3, 'the element accessor reads the seam');
  const copy = c.scenario;
  copy.path.pop();
  assert.equal(c.scenario.path.length, 3, 'accessor hands out copies');
});

test('setScenario has replace semantics: an invalid spec clears the active one', () => {
  const c = plannableChart();
  attachScenario(c);
  c.setScenario({ horizon: 48 });
  assert.ok(c._scenario);
  assert.equal(c.setScenario('nonsense'), null);
  assert.equal(c._scenario, null, 'invalid input clears (never throws)');
  c.setScenario(null);
  assert.equal(c._scenario, null);
  c.clearScenario();
  c.clearScenario(); // idempotent
  assert.equal(c._scenario, null);
});

/* ------------------------- risk plan ------------------------- */

test('setRiskPlan normalizes and stores; clearRiskPlan is guarded', () => {
  const c = plannableChart();
  attachScenario(c);
  const p = c.setRiskPlan({ entry: 64500, stop: 63800, multiples: [1, 2] });
  assert.equal(p, c._riskPlan);
  assert.equal(c.riskPlan.direction, 'long');
  assert.equal(c.riskPlan.levels.length, 2);
  const before = c.invalidations;
  c.clearRiskPlan();
  c.clearRiskPlan(); // no-op on empty → no extra repaint
  assert.equal(c._riskPlan, null);
  assert.equal(c.invalidations, before + 1, 'cleared exactly once');
  assert.equal(c.setRiskPlan({ entry: 100, stop: 100 }), null, 'degenerate plan → null');
});

test('the two plannables are independent (clearing one leaves the other)', () => {
  const c = plannableChart();
  attachScenario(c);
  c.setScenario({ horizon: 24 });
  c.setRiskPlan({ entry: 100, stop: 99 });
  c.clearScenario();
  assert.equal(c._scenario, null);
  assert.equal(c.riskPlan.levels.length, 3, 'risk plan survives');
});

/* ------------------------- detach ------------------------- */

test('detach restores the element methods and leaves chart state alone', () => {
  const c = plannableChart();
  const a = attachScenario(c);
  c.setScenario({ horizon: 48 });
  c.setRiskPlan({ entry: 100, stop: 99 });
  a.detach();
  for (const m of ['setScenario', 'clearScenario', 'setRiskPlan', 'clearRiskPlan']) {
    assert.ok(!c.hasOwnProperty(m), `${m} removed`);
  }
  assert.equal(c._scenario.horizon, 48, 'an active scenario stays drawn — it is chart state');
  assert.equal(c._riskPlan.entry, 100);
  // a detached controller no-ops instead of throwing
  assert.equal(a.setScenario({ horizon: 10 }), null);
  a.clearScenario();
  a.clearRiskPlan();
});

/* ------------------------- component contract ------------------------- */

test('the plugin draws through a public layer and writes the state seams', () => {
  const src = read('plugins/scenario/scenario.mjs');
  assert.match(src, /c\._scenario = normalizeScenario\(spec\)/, 'state on the seam');
  assert.match(src, /c\._riskPlan = normalizeRiskPlan\(spec\)/);
  assert.match(src, /addLayer\(this\._layer\)/, 'rendering moved into the plugin as a layer at the cut');
  assert.match(src, /id: 'wick-scenario'/);
  assert.ok(!src.includes('WickChart.prototype'), 'the prototype is never touched');
  // and the future-space reservation the renderer depends on stays core's
  const chartSrc = read('src/wick-chart.js');
  assert.match(
    chartSrc,
    /_scenario \? Math\.max\(base, this\._scenario\.horizon \+ 3\) : base/,
    'right margin extends by the scenario horizon (the documented seam)'
  );
});

test('scenario/risk stay out of serialized chart state (app state, not chart state)', () => {
  const src = read('src/wick-chart.js');
  assert.doesNotMatch(src, /riskPlan\s*:/, 'no riskPlan key in serialized state');
  assert.doesNotMatch(src, /scenario\s*:/, 'no scenario key in serialized state');
});
