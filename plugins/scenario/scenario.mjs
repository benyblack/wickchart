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

import { normalizeScenario, normalizeRiskPlan, calcVolCone, calcRealizedVol } from './core.mjs';
import { hexToRgba, pillFont, resolveOverlayColor, roundRectPath } from 'wickchart/core';

export { normalizeScenario, normalizeRiskPlan, calcVolCone, calcRealizedVol } from './core.mjs';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const fmtPrice = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toPrecision(4));

/** Local pill renderer (the element's axis-pill look) for R-multiple labels. */
function pill(ctx, H, x, y, text, bg, fg) {
  ctx.save();
  ctx.font = pillFont();
  const tw = ctx.measureText(text).width + 12;
  const th = 18;
  const yy = clamp(y - th / 2, 0, H - th);
  ctx.fillStyle = bg;
  roundRectPath(ctx, x, yy, tw, th, 4);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + tw / 2, yy + th / 2 + 0.5);
  ctx.restore();
  return tw;
}

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
    this._coneKey = '';
    this._cone = null;
    for (const m of INSTALLED) chart[m] = this[m].bind(this);
    chart._wickScenario = this;
    // the projection/risk renderer (moved out of the core entry at 2.0):
    // one layer drawing through the public api — timeToX extrapolates into
    // future space, priceToY maps prices, layout/palette theme it
    this._layer = { id: 'wick-scenario', draw: (api) => this._render(api) };
    if (typeof chart.addLayer === 'function') chart.addLayer(this._layer);
  }

  detach() {
    const c = this._chart;
    if (!c) return;
    if (typeof c.removeLayer === 'function') {
      try {
        c.removeLayer('wick-scenario');
      } catch (_) {}
    }
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

  /** σ-cone for the active scenario, recomputed only when the anchor or
   *  data moves (calcRealizedVol is O(n) — not per frame). */
  _coneFor(d) {
    const sc = this._chart && this._chart._scenario;
    if (!sc || !d || !d.length) return null;
    const last = d[d.length - 1].close;
    const key = d.length + ':' + last + ':' + sc.horizon + ':' + sc.levels.join(',');
    if (this._coneKey !== key) {
      const vol = calcRealizedVol(d.map((b) => b.close), 20);
      let v = NaN;
      for (let i = vol.length - 1; i >= 0; i--) {
        if (Number.isFinite(vol[i])) {
          v = vol[i];
          break;
        }
      }
      this._cone = calcVolCone(last, v, sc.horizon, sc.levels);
      this._coneKey = key;
    }
    return this._cone;
  }

  /* ---------------- the renderer (a plugin layer) ---------------- */

  _render(api) {
    const c = this._chart;
    if (!c) return;
    const { ctx, layout: ly, palette: pal, data: d, priceToY, timeToX } = api;
    const sc = c._scenario;
    const rp = c._riskPlan;
    if ((!sc && !rp) || !d || !d.length || !ly) return;
    const main = ly.main;
    const yOf = (p) => priceToY(p);
    const xAt = (h) => timeToX(d[d.length - 1].time + h * ((d[1] && d[1].time - d[0].time) || 3600e3));

    if (sc) {
      const col = resolveOverlayColor(sc.color, pal);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, main.y0, ly.plotRight, main.h);
      ctx.clip();
      if (sc.cone) {
        const cone = this._coneFor(d);
        if (cone) {
          for (let li = cone.levels.length - 1; li >= 0; li--) {
            const b = cone.bands[cone.levels[li]];
            ctx.globalAlpha = li === 0 ? 0.1 : 0.05;
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.moveTo(xAt(0), yOf(b.up[0]));
            for (let h = 1; h <= cone.horizon; h++) ctx.lineTo(xAt(h), yOf(b.up[h]));
            for (let h = cone.horizon; h >= 0; h--) ctx.lineTo(xAt(h), yOf(b.down[h]));
            ctx.closePath();
            ctx.fill();
          }
          const inner = cone.bands[cone.levels[0]];
          ctx.globalAlpha = 0.4;
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          for (const arr of [inner.up, inner.down]) {
            ctx.beginPath();
            ctx.moveTo(xAt(0), yOf(arr[0]));
            for (let h = 1; h <= cone.horizon; h++) ctx.lineTo(xAt(h), yOf(arr[h]));
            ctx.stroke();
          }
          ctx.setLineDash([]);
        }
      }
      if (sc.path.length) {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(xAt(0), yOf(d[d.length - 1].close));
        for (const p of sc.path) ctx.lineTo(xAt(p.h), yOf(p.price));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col;
        for (const p of sc.path) {
          const y = yOf(p.price);
          if (y >= main.y0 && y <= main.y0 + main.h) {
            ctx.beginPath();
            ctx.arc(xAt(p.h), y, 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        if (sc.label) {
          const p = sc.path[sc.path.length - 1];
          ctx.font = pillFont();
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = col;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(sc.label, Math.min(xAt(p.h) + 8, ly.plotRight - 4), clamp(yOf(p.price), main.y0 + 8, main.y0 + main.h - 8));
        }
      }
      ctx.restore();
    }

    if (rp) {
      const yE = yOf(rp.entry);
      const yS = yOf(rp.stop);
      ctx.fillStyle = hexToRgba(pal.down, 0.06);
      ctx.fillRect(0, Math.min(yE, yS), ly.plotRight, Math.abs(yS - yE));
      const yTop = yOf(rp.levels[rp.levels.length - 1].price);
      ctx.fillStyle = hexToRgba(pal.up, 0.05);
      ctx.fillRect(0, Math.min(yE, yTop), ly.plotRight, Math.abs(yTop - yE));
      const line = (p, colr, dash) => {
        const y = yOf(p);
        if (y < main.y0 || y > main.y0 + main.h) return null;
        ctx.strokeStyle = colr;
        ctx.lineWidth = 1.5;
        if (dash) ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(ly.plotRight, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        return y;
      };
      const pills = [];
      for (let i = rp.levels.length - 1; i >= 0; i--) {
        const lv = rp.levels[i];
        const y = line(lv.price, pal.up, true);
        if (y != null) pills.push({ y, text: `${lv.k % 1 === 0 ? lv.k : +lv.k.toFixed(2)}R ${fmtPrice(lv.price)}`, bg: pal.up });
      }
      const yStop = line(rp.stop, pal.down, false);
      if (yStop != null) pills.push({ y: yStop, text: `STOP ${fmtPrice(rp.stop)}`, bg: pal.down });
      const yEnt = line(rp.entry, pal.accent, false);
      if (yEnt != null) {
        pills.push({ y: yEnt, text: `${rp.direction === 'long' ? 'LONG' : 'SHORT'} ${fmtPrice(rp.entry)}`, bg: pal.accent });
      }
      // stack right-edge pills instead of letting close lines overlap
      pills.sort((a, b) => a.y - b.y);
      let lastY = -Infinity;
      for (const p of pills) {
        const y = Math.max(p.y, lastY + 20);
        lastY = y;
        const tw = pill(ctx, ly.H, ly.plotRight - ctx.measureText(p.text).width - 20, y, p.text, p.bg, pal.pillText);
        void tw;
      }
      if (rp.label) {
        ctx.font = pillFont();
        ctx.fillStyle = pal.accent;
        ctx.globalAlpha = 0.9;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(rp.label, 8, clamp(yE, main.y0 + 14, main.y0 + main.h) - 3);
        ctx.globalAlpha = 1;
      }
    }
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
