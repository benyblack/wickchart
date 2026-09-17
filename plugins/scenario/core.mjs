/**
 * wickchart-scenario/core — the pure surface of scenario planning: spec
 * validation (ghost paths, σ-cone settings, R-multiple risk plans) and the
 * cone / realized-volatility math. No DOM, no chart.
 *
 * During 1.x these functions live in wickchart/core and are re-exported
 * here unchanged (they are shared: the scene validator in
 * wickchart-narrator imports the same normalizers, and the AI data window
 * uses the same realized-vol). At the 2.0 cut the scenario-only math
 * (calcVolCone) and the normalizers' final home are settled — see
 * ROADMAP-V2.md; until then this re-export is the package's import seam.
 */

export {
  normalizeScenario,
  normalizeRiskPlan,
  calcVolCone,
  calcRealizedVol,
} from 'wickchart/core';
