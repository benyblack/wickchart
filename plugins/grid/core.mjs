/**
 * wickchart-grid — pure multi-chart sync model: range fan-out with echo and
 * clamp-cycle guards, crosshair mirroring via ghost layers, sync-spec
 * parsing. No DOM, no canvas: charts are duck-typed event targets and the
 * ghost draws through the api object the core layer API hands it. Everything
 * here is unit-testable plain logic in / plain calls out (see tests/).
 */

/** Sync kinds: 'range' (shared visible range), 'crosshair' (time + price
 *  lines), 'time' (vertical time line only — mixed-price grids). */
export const SYNC_KINDS = ['range', 'crosshair', 'time'];

/**
 * Parse a sync spec — space/comma list of kinds, 'both' as shorthand,
 * 'off'/'none' as an explicit empty group. Unknown tokens are ignored; a
 * spec with no recognized tokens falls back to range + crosshair (the same
 * tolerance the chart applies to attribute input) — except the explicit
 * off switch, which means no sync at all.
 * @param {string} spec e.g. 'range crosshair' | 'time' | '' | 'off'
 * @returns {Set<string>}
 */
export function parseSync(spec) {
  const out = new Set();
  const tokens = String(spec == null ? '' : spec)
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  let off = false;
  for (const t of tokens) {
    if (t === 'both') {
      out.add('range');
      out.add('crosshair');
    } else if (t === 'off' || t === 'none') {
      off = true;
    } else if (SYNC_KINDS.includes(t)) out.add(t);
  }
  if (off) return new Set(); // the explicit switch wins over anything listed beside it
  if (!out.size) {
    out.add('range');
    out.add('crosshair');
  }
  return out;
}

/** Two ranges equal within a millisecond (they are ms floats in practice). */
function nearRange(a, b) {
  return (
    a && b && Math.abs(a.from - b.from) < 1 && Math.abs(a.to - b.to) < 1
  );
}

/**
 * The mirrored crosshair on one chart: a layer that draws dashed time/price
 * lines at the last synced position and repaints on request. The layer is
 * attached lazily on the first update — a grid that connects before its
 * charts upgrade still gets ghosts, because by the time any crosshair event
 * fires the source chart (and so its siblings' elements) are upgraded.
 */
export function makeGhost(chart, id = 'wick-grid-sync') {
  const state = { at: null }; // { time, price } | null
  let layer = null;
  return {
    /** @param {{time: number|null, price: number|null}|null} at */
    update(at) {
      state.at = at;
      if (!layer && at && typeof chart.addLayer === 'function') {
        layer = chart.addLayer({
          id,
          insetBottom: 0,
          draw(api) {
            const { ctx, layout: ly, palette: pal } = api;
            const pos = state.at;
            if (!pos || !ly) return;
            ctx.save();
            ctx.strokeStyle = pal.crosshair || pal.grid || 'rgba(230,237,243,0.42)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            if (pos.time != null && typeof api.timeToX === 'function') {
              const x = api.timeToX(pos.time);
              if (x >= 0 && x <= ly.plotRight) {
                ctx.beginPath();
                ctx.moveTo(Math.round(x) + 0.5, 0);
                ctx.lineTo(Math.round(x) + 0.5, ly.plotBottom);
                ctx.stroke();
              }
            }
            if (pos.price != null && typeof api.priceToY === 'function') {
              const y = api.priceToY(pos.price);
              if (y >= 0 && y <= ly.main.h) {
                ctx.beginPath();
                ctx.moveTo(0, Math.round(y) + 0.5);
                ctx.lineTo(ly.plotRight, Math.round(y) + 0.5);
                ctx.stroke();
              }
            }
            ctx.restore();
          },
        });
      }
      if (layer && typeof chart.requestDraw === 'function') chart.requestDraw();
    },
    detach() {
      if (layer && typeof chart.removeLayer === 'function') {
        chart.removeLayer(typeof layer === 'object' ? layer.id : layer);
      }
      layer = null;
      state.at = null;
    },
  };
}

/**
 * A sync group. Add charts (they must fire `wick:range` / `wick:crosshair`
 * and expose setVisibleRange / getVisibleRange; addLayer is optional), and
 * the group keeps their visible ranges and crosshairs in step:
 *
 *   - a chart's own range change is fanned out to the others; the echoes
 *     that application produces are swallowed, and clamp feedback loops
 *     (two charts whose data cannot both display a range) die out instead
 *     of ping-ponging — the same target arriving inside 250 ms is a cycle,
 *     not a user;
 *   - a crosshair move mirrors as a dashed ghost on the others, and a leave
 *     (null detail) clears every ghost.
 */
export class GridSync {
  /** @param {{sync?: string}} [opts] */
  constructor(opts = {}) {
    this.kinds = parseSync(opts.sync);
    this._charts = new Set();
    this._ghosts = new Map();
    this._echo = new Map(); // chart → the range we last applied to it
    this._lastFan = null; // { from, to, at } cycle breaker
    this._onRange = (e) => this._rangeFrom(e.target, e.detail);
    this._onCross = (e) => this._crossFrom(e.target, e.detail);
  }

  /** Register a chart. Idempotent; returns false for junk input. */
  add(chart) {
    if (!chart || typeof chart.addEventListener !== 'function' || this._charts.has(chart)) {
      return false;
    }
    this._charts.add(chart);
    this._ghosts.set(chart, makeGhost(chart));
    this._echo.delete(chart);
    chart.addEventListener('wick:range', this._onRange);
    chart.addEventListener('wick:crosshair', this._onCross);
    return true;
  }

  /** Unregister a chart (ghost layer removed). Returns true if it was in. */
  remove(chart) {
    if (!this._charts.delete(chart)) return false;
    const g = this._ghosts.get(chart);
    if (g) g.detach();
    this._ghosts.delete(chart);
    this._echo.delete(chart);
    chart.removeEventListener('wick:range', this._onRange);
    chart.removeEventListener('wick:crosshair', this._onCross);
    return true;
  }

  /** Unregister everything (ghost layers removed). */
  detach() {
    for (const c of [...this._charts]) this.remove(c);
  }

  /** The registered charts, in insertion order. */
  charts() {
    return [...this._charts];
  }

  _rangeFrom(src, r) {
    if (!this.kinds.has('range') || !r) return;
    // our own echo: the range we applied to this chart arriving back
    const echo = this._echo.get(src);
    this._echo.delete(src);
    if (echo && nearRange(echo, r)) return;
    // clamp cycle: the same target fanning back out within 250 ms is a
    // feedback loop between clamping charts, not a user action
    const now = Date.now();
    if (this._lastFan && nearRange(this._lastFan, r) && now - this._lastFan.at < 250) return;
    this._lastFan = { from: r.from, to: r.to, at: now };
    for (const c of this._charts) {
      if (c === src) continue;
      if (typeof c.setVisibleRange !== 'function') continue;
      let cur = null;
      try {
        cur = typeof c.getVisibleRange === 'function' ? c.getVisibleRange() : null;
      } catch (_) {}
      if (nearRange(cur, r)) continue;
      this._echo.set(c, r);
      try {
        c.setVisibleRange(r);
      } catch (_) {
        this._echo.delete(c);
      }
    }
  }

  _crossFrom(src, detail) {
    const both = this.kinds.has('crosshair');
    if (!both && !this.kinds.has('time')) return;
    const at = detail && detail.bar && detail.price != null
      ? { time: detail.bar.time, price: both ? detail.price : null }
      : null;
    for (const c of this._charts) {
      if (c === src) continue;
      const g = this._ghosts.get(c);
      if (g) g.update(at);
    }
  }
}

/**
 * Programmatic attach for chart collections outside a `<wick-grid>` element.
 * @param {Array<object>} charts
 * @param {{sync?: string}} [opts]
 * @returns {GridSync}
 */
export function attachGrid(charts, opts = {}) {
  const grid = new GridSync(opts);
  for (const c of Array.isArray(charts) ? charts : []) grid.add(c);
  return grid;
}
