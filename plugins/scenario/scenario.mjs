/**
 * wickchart-scenario — scenario planning for wickchart, as a plugin:
 * project a ghost path of future prices with σ-bands (a volatility cone
 * widening with √h from realized volatility), and lay out an R-multiple
 * risk plan (entry/stop anchor, kR reward lines, risk/reward shading) so
 * sizing and take-profit choices read directly off the chart.
 *
 *   import { attachScenario } from 'wickchart-scenario';
 *
 *   const scenario = attachScenario(chart);
 *   chart.setScenario({ path: [64000, 65500, 68000], label: 'bull case' });
 *   chart.setScenario({ horizon: 48 });            // cone-only projection
 *   chart.scenario;                                 // a copy of the active one
 *   chart.setRiskPlan({ entry: 64500, stop: 63800, multiples: [1, 2, 3] });
 *   chart.riskPlan;                                 // { entry, stop, risk, levels, … }
 *   chart.clearScenario();
 *   chart.clearRiskPlan();
 *   scenario.detach();
 *
 * Calls keep their core shape — the familiar methods are installed on the
 * instance, so code written against chart.setScenario() works with one
 * added import. Until 2.0 the core element ships its own identical
 * methods; attaching shadows them (see ROADMAP-V2.md).
 *
 * Element contract — the smallest of the family: the plugin writes the
 * documented state seams `_scenario` / `_riskPlan` that the element's
 * renderer, cone cache, future-space reservation (`_rightMargin` extends
 * by the scenario horizon), `scenario` / `riskPlan` accessors and
 * getState-exclusion already read. Everything else stays the element's.
 */

import { normalizeScenario, normalizeRiskPlan } from './core.mjs';

export { normalizeScenario, normalizeRiskPlan, calcVolCone, calcRealizedVol } from './core.mjs';

const INSTALLED = ['setScenario', 'clearScenario', 'setRiskPlan', 'clearRiskPlan'];

export function attachScenario(chart) {
  return new Scenario(chart);
}

export class Scenario {
  /**
   * @param {object} chart a <wick-chart> (or anything with its invalidate /
   *   scenario-state surface) to install the planning methods on
   */
  constructor(chart) {
    if (!chart || typeof chart._invalidate !== 'function') {
      throw new TypeError('attachScenario(chart): the chart element is required');
    }
    if (chart._wickScenario) return chart._wickScenario; // idempotent attach
    this._chart = chart;
    for (const m of INSTALLED) chart[m] = this[m].bind(this);
    chart._wickScenario = this;
  }

  detach() {
    const c = this._chart;
    if (!c) return;
    for (const m of INSTALLED) {
      try {
        delete c[m];
      } catch (_) {}
    }
    // state on the seams belongs to the chart — an active scenario/risk
    // plan stays drawn, and the element's own methods resume control
    try {
      delete c._wickScenario;
    } catch (_) {}
    this._chart = null;
  }

  /**
   * Scenario projection into future space: a ghost path of future prices
   * plus optional σ-bands (vol cone) from realized volatility. Invalid
   * specs clear the scenario (replace semantics). Setting one reserves
   * future space on the right.
   * @param {object} spec { path?, horizon?, cone?, levels?, color?, label? }
   * @returns {object|null} the normalized scenario, or null when invalid
   */
  setScenario(spec) {
    const c = this._chart;
    if (!c) return null;
    c._scenario = normalizeScenario(spec);
    c._invalidate();
    return c._scenario;
  }

  clearScenario() {
    const c = this._chart;
    if (!c) return;
    c._scenario = null;
    c._invalidate();
  }

  /**
   * Risk plan: an R-multiple grid anchored at entry/stop. 1R = |entry −
   * stop|; reward lines are drawn at kR beyond the entry with risk/reward
   * zones shaded. Direction is derived (stop below entry ⇒ long); targets
   * convert to their R multiple; `multiples` win when both are given.
   * @param {object} spec { entry, stop, multiples? | targets?, label? }
   * @returns {object|null} the normalized plan, or null when invalid
   */
  setRiskPlan(spec) {
    const c = this._chart;
    if (!c) return null;
    c._riskPlan = normalizeRiskPlan(spec);
    c._invalidate();
    return c._riskPlan;
  }

  clearRiskPlan() {
    const c = this._chart;
    if (!c || !c._riskPlan) return;
    c._riskPlan = null;
    c._invalidate();
  }
}
