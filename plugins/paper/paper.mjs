/**
 * wickchart-paper — paper trading on top of wickchart-replay, as a plugin:
 * place orders while the tape replays (or streams live), watch them fill at
 * honest prices, and see the session's equity curve docked under the chart.
 * The engine (fills, netting, fees, drawdown) is pure data in / data out in
 * wickchart-paper/core; this module drives it from the chart's public
 * `wick:replay` events and renders through the layer API — zero core changes.
 *
 *   import { attachReplay } from 'wickchart-replay';
 *   import { attachPaper } from 'wickchart-paper';
 *
 *   const replay = attachReplay(chart);
 *   const paper = attachPaper(chart, { cash: 10000, fee: 0.0004 });
 *   replay.start();           // ~70% into the data
 *   paper.buy(1);             // queued — fills at the NEXT bar's open
 *   paper.buyLimit(95, 1);    // working until a bar trades through it
 *   paper.flatten();          // market-close the whole position
 *   paper.stats;              // equity, realized, trades, winRate, maxDD…
 *   paper.detach();
 *
 * Events on the chart (`wick:paper`): order / fill / close / cancel / reset —
 * detail carries the affected object plus the live position and realized P&L.
 *
 * Honesty contract (mirrored from the engine): an order placed while paused
 * at bar N fills during bar N+1 — you can never trade a close you already
 * saw; market orders fill at the next open; limits fill at the limit unless
 * the open gaps through them (the better price). Seeking the replay back
 * (or looping) resets the session: equity restarts from the anchor.
 */

import { PaperModel } from './core.mjs';

export { PaperModel } from './core.mjs';

const DOCK = 44; // px of docked equity strip
const FONT = '600 10px ui-sans-serif, system-ui, sans-serif';

const fmtMoney = (v) => {
  const a = Math.abs(v);
  const s = (v < 0 ? '-' : '') + '$';
  if (a >= 1e6) return s + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return s + (a / 1e3).toFixed(1) + 'k';
  return s + a.toFixed(0);
};

export function attachPaper(chart, opts = {}) {
  return new Paper(chart, opts);
}

export class Paper {
  /**
   * @param {object} chart a <wick-chart> (or anything with its data/layer/
   *   positions API) driven by wickchart-replay
   * @param {{cash?: number, fee?: number, dock?: number}} [opts]
   */
  constructor(chart, opts = {}) {
    if (!chart || typeof chart.addLayer !== 'function' || typeof chart.addEventListener !== 'function') {
      throw new TypeError('attachPaper(chart): the chart element is required');
    }
    this._chart = chart;
    this._model = new PaperModel(opts);
    this._lastIndex = -1; // replay head already traded through
    this._posId = 'wick-paper-position';
    this._onReplay = (e) => this._advance(e.detail || {});
    chart.addEventListener('wick:replay', this._onReplay);
    this._layer = {
      id: 'wick-paper',
      insetBottom: Math.max(24, Math.min(160, Math.round(opts.dock ?? DOCK))),
      draw: (api) => this._render(api),
    };
    chart.addLayer(this._layer);
  }

  /* ---------------- order entry (fires wick:paper) ---------------- */

  buy(qty = 1) {
    return this._order(this._model.buy(qty));
  }

  sell(qty = 1) {
    return this._order(this._model.sell(qty));
  }

  buyLimit(price, qty = 1) {
    return this._order(this._model.buyLimit(price, qty));
  }

  sellLimit(price, qty = 1) {
    return this._order(this._model.sellLimit(price, qty));
  }

  /** Close the whole position at the next open. */
  flatten() {
    return this._order(this._model.flatten());
  }

  cancel(id) {
    const ok = this._model.cancel(id);
    if (ok) this._fire('cancel', { id });
    return ok;
  }

  /** Reset the session (equity restarts from the current anchor). */
  reset(time) {
    this._model.reset(time != null ? time : this._anchorTime());
    this._mirrorPosition();
    this._requestDraw();
    this._fire('reset', {});
    return this;
  }

  detach() {
    try {
      this._chart.removeEventListener('wick:replay', this._onReplay);
      this._chart.removeLayer('wick-paper');
      this._chart.removePosition(this._posId);
    } catch (_) {}
    this._chart = null;
  }

  /** Session readout — see PaperModel#stats plus the equity series. */
  get stats() {
    return { ...this._model.stats(), series: this._model.series };
  }

  /* ---------------- replay wiring ---------------- */

  /** The replay head moved: trade every newly revealed bar, in order. */
  _advance(d) {
    if (!this._chart) return;
    if (!d.active) return; // replay exited — freeze the session readout
    const data = this._chart.data;
    if (!data || !data.length) return;
    if (d.index < this._lastIndex) {
      // seek back / loop / restart — the session restarts from the anchor
      this._lastIndex = d.index;
      this._model.reset(data[data.length - 1].time);
      this._mirrorPosition();
      this._fire('reset', { reason: 'seek' });
    } else if (this._lastIndex < 0) {
      this._lastIndex = d.index; // first event: anchor is context, not trades
      if (!this._model.series.length) this._model.reset(data[data.length - 1].time);
      return;
    }
    for (let i = this._lastIndex + 1; i <= d.index && i < data.length; i++) {
      this._onBar(data[i]);
    }
    this._lastIndex = Math.min(d.index, data.length - 1);
  }

  _onBar(b) {
    const fills = this._model.onBar(b);
    if (!fills.length) return;
    for (const f of fills) {
      this._fire('fill', { fill: f });
      // a fill that reduced or closed produced a logged trade
      for (const t of this._model.closed) {
        if (t.at === f.time && t.exit === f.price) this._fire('close', { trade: t });
      }
    }
    this._mirrorPosition();
    this._requestDraw();
  }

  /** Mirror the open position onto the core positions API (entry line +
   *  live P&L readout) so the trade is visible on the price chart itself. */
  _mirrorPosition() {
    const p = this._model.pos;
    if (p && p.qty !== 0) {
      this._chart.addPosition({
        id: this._posId,
        side: p.qty > 0 ? 'long' : 'short',
        entry: p.entry,
        qty: Math.abs(p.qty),
      });
    } else {
      this._chart.removePosition(this._posId);
    }
  }

  _anchorTime() {
    const s = this._model.series;
    return s.length ? s[0].time : Date.now();
  }

  _order(o) {
    if (o) this._fire('order', { order: { ...o } });
    return o;
  }

  _fire(action, extra) {
    if (!this._chart || typeof this._chart.dispatchEvent !== 'function') return;
    this._chart.dispatchEvent(
      new CustomEvent('wick:paper', {
        detail: {
          action,
          position: this._model.pos ? { ...this._model.pos } : null,
          realized: this._model.realized,
          equity: this._model.series.length
            ? this._model.series[this._model.series.length - 1].equity
            : this._model.startCash,
          ...extra,
        },
      })
    );
  }

  _requestDraw() {
    if (this._chart && typeof this._chart.requestDraw === 'function') this._chart.requestDraw();
  }

  /* ---------------- equity strip (docked layer) ---------------- */

  _render(api) {
    const { ctx, layout: ly, palette: pal } = api;
    const dock = ly && ly.dock;
    const m = this._model;
    if (!dock || !m.series.length) return;

    // opaque backing — the strip owns its pixels (same convention as tape)
    ctx.save();
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, dock.y0, ly.W, dock.h);
    ctx.strokeStyle = pal.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(dock.y0) + 0.5);
    ctx.lineTo(ly.W, Math.round(dock.y0) + 0.5);
    ctx.stroke();

    // vertical scale: equity extremes with the starting cash included
    let lo = m.startCash;
    let hi = m.startCash;
    for (const p of m.series) {
      if (p.equity < lo) lo = p.equity;
      if (p.equity > hi) hi = p.equity;
    }
    if (hi - lo < 1e-9) {
      hi += 1;
      lo -= 1;
    }
    const pad = 5;
    const y = (e) => dock.y0 + dock.h - pad - ((e - lo) / (hi - lo)) * (dock.h - pad * 2);
    const last = m.series[m.series.length - 1];
    const up = last.equity >= m.startCash;

    // starting-cash baseline
    ctx.strokeStyle = pal.grid;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y(m.startCash)) + 0.5);
    ctx.lineTo(ly.plotRight, Math.round(y(m.startCash)) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    // the equity line
    ctx.strokeStyle = up ? pal.up : pal.down;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (const p of m.series) {
      const x = api.timeToX(p.time);
      if (x < -40) continue; // long-left points only cost time
      if (!started) {
        ctx.moveTo(x, y(p.equity));
        started = true;
      } else ctx.lineTo(x, y(p.equity));
    }
    ctx.stroke();

    // fills as dots on the curve
    for (const f of m.fills) {
      const x = api.timeToX(f.time);
      if (x < 0 || x > ly.plotRight) continue;
      ctx.fillStyle = f.side > 0 ? pal.up : pal.down;
      ctx.beginPath();
      ctx.arc(x, y(this._equityAt(f.time)), 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // readout: current equity, session P&L, drawdown
    const pnl = last.equity - m.startCash;
    const pct = (pnl / m.startCash) * 100;
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillStyle = up ? pal.up : pal.down;
    const head =
      fmtMoney(last.equity) + '  ' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
    ctx.fillText(head, ly.plotRight - 6, dock.y0 + dock.h / 2);
    ctx.textAlign = 'left';
    ctx.fillStyle = pal.text || pal.grid;
    const s = m.stats();
    const meta =
      'PAPER · ' + m.closed.length + ' trades' +
      (m.closed.length ? ' · ' + Math.round((s.wins / m.closed.length) * 100) + '% win' : '') +
      (m.maxDD > 0 ? ' · maxDD ' + (m.maxDD * 100).toFixed(1) + '%' : '');
    ctx.fillText(meta, 8, dock.y0 + dock.h / 2);
    ctx.restore();
  }

  /** Closest equity value at `time` (fills mark on their bar's close). */
  _equityAt(time) {
    const s = this._model.series;
    let v = s.length ? s[0].equity : this._model.startCash;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].time <= time) return s[i].equity;
      v = s[i].equity;
    }
    return v;
  }
}
