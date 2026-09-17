/**
 * wickchart-scenario/core — the pure surface of scenario planning: spec
 * validation (ghost paths, σ-cone settings, R-multiple risk plans), the
 * √h cone math and realized volatility. No DOM, no chart.
 *
 * normalizeScenario / normalizeRiskPlan / calcRealizedVol are re-exported
 * from wickchart/core unchanged (they are shared: the scene validator in
 * wickchart-narrator imports the same normalizers, and the AI data window
 * uses the same realized vol). The cone math is owned here — it left the
 * core entry at the 2.0 cut.
 */

import { normalizeScenario, normalizeRiskPlan, calcRealizedVol } from 'wickchart/core';

export { normalizeScenario, normalizeRiskPlan, calcRealizedVol };

/**
 * σ-cone projection from realized per-bar volatility: price bands widening
 * with √h (GBM-style, exp(±z·σ·√h)) over `horizon` future bars.
 * @param {number} lastClose anchor price (bar 0)
 * @param {number} volPerBar per-bar stddev of log returns (from calcRealizedVol)
 * @param {number} horizon future bars (clamped 1–500, default 48)
 * @param {number[]} [levels] σ multipliers, e.g. [1, 2] (each clamped to 0–5)
 * @returns {{horizon: number, levels: number[], bands: Record<string, {up: number[], down: number[]}>}}
 *          bands[z].up/.down are arrays indexed by h = 0…horizon ([0] === lastClose)
 */
export function calcVolCone(lastClose, volPerBar, horizon, levels) {
  const zs = (Array.isArray(levels) && levels.length ? levels : [1, 2])
    .map((z) => +z)
    .filter((z) => Number.isFinite(z) && z > 0 && z <= 5)
    .sort((a, b) => a - b);
  const lv = zs.length ? zs : [1];
  const H = Math.max(1, Math.min(500, Math.round(+horizon || 48)));
  const c = +lastClose;
  const v = +volPerBar;
  const bands = {};
  const flat = !Number.isFinite(c) || c <= 0 || !Number.isFinite(v) || v < 0;
  for (const z of lv) {
    const up = new Array(H + 1);
    const down = new Array(H + 1);
    for (let h = 0; h <= H; h++) {
      if (flat) {
        up[h] = c || 0;
        down[h] = c || 0;
      } else {
        const k = Math.exp(z * v * Math.sqrt(h));
        up[h] = c * k;
        down[h] = c / k;
      }
    }
    bands[z] = { up, down };
  }
  return { horizon: H, levels: lv, bands };
}
