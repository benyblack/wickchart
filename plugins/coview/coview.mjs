/**
 * wickchart-coview — cross-tab co-view for wickchart, as a plugin: charts
 * that share a `co-view` room name keep each other briefed. Every pan/zoom
 * broadcasts the visible window (throttled to ~8/s, heartbeat every 4 s),
 * each peer renders the others' viewports as labeled bands along the top
 * of the plot, and the crosshair is shared live — a dashed ghost mirrors
 * the pointer of the tab you are pairing with. Closed tabs say goodbye, or
 * fade via the 12 s presence TTL.
 *
 *   import { attachCoview } from 'wickchart-coview';
 *
 *   <wick-chart co-view="btc-warroom" co-view-name="Maya"></wick-chart>
 *   const coview = attachCoview(chart);
 *   chart.getPeers();            // [{ id, name, range: {from,to}, at }]
 *   coview.detach();
 *
 * Until 2.0 the core element ships its own identical machinery; attaching
 * shadows it with the same behavior (see ROADMAP-V2.md). The transport is
 * the public BroadcastChannel `wick-co-view:<room>` protocol (v1 envelope,
 * view / cross / bye messages) — anything that can postMessage can join.
 *
 * Element contract — the plugin drives the documented co-view state the
 * core renderer and lifecycle already know: `_coviewCh` (broadcast gate on
 * crosshair/range + disconnect cleanup), `_coviewBeat` / `_ghostTimer`
 * (cleared on disconnect), `_presence` (band source) and `_ghost` (peer
 * pointer). It installs `_setupCoView` / `_coviewSend` / `_coviewSendView`
 * / `_onCoMessage` / `getPeers` as own properties, so the `co-view`
 * attribute changes, the connect/disconnect lifecycle, pan/zoom
 * broadcasting and the crosshair share all route through the plugin.
 */

import {
  CHANNEL_PREFIX,
  PresenceTracker,
  coWrap,
  coUnwrap,
  viewMessage,
  crossMessage,
  indexForTime,
} from './core.mjs';

export { PresenceTracker, CHANNEL_PREFIX, coWrap, coUnwrap } from './core.mjs';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const INSTALLED = ['getPeers', '_setupCoView', '_coviewSend', '_coviewSendView', '_onCoMessage'];

export function attachCoview(chart, opts = {}) {
  return new Coview(chart, opts);
}

export class Coview {
  /**
   * @param {object} chart a <wick-chart> (or anything with its data / range /
   *   event surface) whose co-view machinery should be driven by the plugin
   * @param {{channel?: (name: string) => object, ttl?: number, beatMs?: number}} [opts]
   *        channel — injectable transport factory (tests, WebSockets);
   *        beatMs — presence heartbeat (default 4 s)
   */
  constructor(chart, opts = {}) {
    if (
      !chart ||
      typeof chart.getVisibleRange !== 'function' ||
      typeof chart.dispatchEvent !== 'function' ||
      typeof chart._invalidate !== 'function'
    ) {
      throw new TypeError('attachCoview(chart): the chart element is required');
    }
    if (chart._wickCoview) return chart._wickCoview; // idempotent attach
    this._chart = chart;
    this._peer = 'p' + Math.random().toString(36).slice(2, 8);
    this._injected = typeof opts.channel === 'function';
    this._openChannel =
      this._injected ? opts.channel : (name) => new BroadcastChannel(CHANNEL_PREFIX + name);
    this._beatMs = Math.max(250, Math.round(+opts.beatMs || 4000));
    this._tracker = new PresenceTracker(opts.ttl);
    this._viewLast = 0;
    // state the element's renderer + lifecycle already drive — own-property
    // assignments so core reads the plugin's live tracker/ghost/channel
    chart._presence = this._tracker;
    chart._ghost = null;
    chart._ghostTimer = 0;
    chart._coviewCh = null;
    chart._coviewBeat = 0;
    for (const m of INSTALLED) chart[m] = this[m].bind(this);
    chart._wickCoview = this;
    // the presence-band + ghost renderer (moved out of the core entry at
    // 2.0): one layer drawing through the public api
    this._layer = { id: 'wick-coview', draw: (api) => this._render(api) };
    if (typeof chart.addLayer === 'function') chart.addLayer(this._layer);
    // the co-view attribute is plugin-owned since 2.0: watch it live
    if (typeof MutationObserver === 'function') {
      this._observer = new MutationObserver(() => this._setupCoView());
      this._observer.observe(chart, { attributes: true, attributeFilter: ['co-view'] });
    }
    // the attribute may predate the attach — join the room if set
    if (this._room()) this._setupCoView();
  }

  /** The room name from the plugin-owned `co-view` attribute. */
  _room() {
    const c = this._chart;
    const v = c && typeof c.getAttribute === 'function' ? c.getAttribute('co-view') : null;
    return v || null;
  }

  detach() {
    const c = this._chart;
    if (!c) return;
    if (this._observer) {
      try {
        this._observer.disconnect();
      } catch (_) {}
      this._observer = null;
    }
    if (typeof c.removeLayer === 'function') {
      try {
        c.removeLayer('wick-coview');
      } catch (_) {}
    }
    this._teardown(true);
    for (const m of INSTALLED) {
      try {
        delete c[m];
      } catch (_) {}
    }
    // hand the element back a clean slate (no tracker, no ghost)
    this._tracker = new PresenceTracker(this._tracker.ttl);
    c._presence = null;
    this._tracker = null;
    c._ghost = null;
    try {
      delete c._wickCoview;
    } catch (_) {}
    this._chart = null;
  }

  /** Live co-view peers: [{ id, name, range: {from,to}, at }], oldest
   *  sighting first. Peers fade out ~12 s after their last sighting. */
  getPeers() {
    return this._tracker ? this._tracker.list() : [];
  }

  /* ---------------- room lifecycle ---------------- */

  /** Join/leave the room named by the chart's `co-view` attribute. */
  _setupCoView() {
    const c = this._chart;
    if (!c) return;
    this._teardown(false);
    const name = this._room();
    if (!name || !c._connected) return;
    if (typeof BroadcastChannel === 'undefined' && !this._injected) return;
    try {
      const ch = this._openChannel(name);
      ch.onmessage = (ev) => this._onCoMessage(ev.data);
      this._ch = ch;
      c._coviewCh = ch; // core gates crosshair/range sharing + cleanup on this
    } catch (_) {
      return;
    }
    // presence: announce immediately, then heartbeat so idle peers stay
    // warm (and stale ones sweep) without waiting for a pan/zoom
    this._coviewSendView(true);
    c._coviewBeat = setInterval(() => {
      this._coviewSendView(true);
      const left = this._tracker.sweep();
      if (left.length) {
        this._fire('peers', { peers: this._tracker.list(), joined: [], left });
        c._invalidate();
      }
    }, this._beatMs);
  }

  /** Stop the current room: close the channel (optionally goodbye), clear
   *  timers, drop presence. Mirrors what the element expects on teardown. */
  _teardown(sayBye) {
    const c = this._chart;
    if (!c) return;
    if (c._coviewCh) {
      if (sayBye) this._coviewSend({ type: 'bye' });
      try {
        c._coviewCh.close();
      } catch (_) {}
      c._coviewCh = null;
      this._ch = null;
    }
    clearInterval(c._coviewBeat);
    c._coviewBeat = 0;
    clearTimeout(c._ghostTimer);
    c._ghostTimer = 0;
    if (c._ghost) {
      c._ghost = null;
      c._invalidate();
    }
    if (this._tracker.peers.size) {
      const left = this._tracker.list();
      this._tracker = new PresenceTracker(this._tracker.ttl);
      c._presence = this._tracker;
      this._fire('peers', { peers: [], joined: [], left });
    }
  }

  /* ---------------- protocol ---------------- */

  /** Broadcast our visible range for presence; throttled unless forced. */
  _coviewSendView(force) {
    if (!this._ch) return;
    const r = this._chart.getVisibleRange();
    if (!r) return;
    const now = performance.now();
    if (!force && now - this._viewLast < 120) return;
    this._viewLast = now;
    const label =
      this._chart && typeof this._chart.getAttribute === 'function'
        ? this._chart.getAttribute('co-view-name')
        : null;
    this._coviewSend(viewMessage(r.from, r.to, label || null));
  }

  _coviewSend(msg) {
    if (!this._ch) return;
    try {
      this._ch.postMessage(coWrap(this._peer, msg));
    } catch (_) {}
  }

  /** Handle one envelope from the room (view / cross / bye). */
  _onCoMessage(m) {
    const c = this._chart;
    if (!c) return;
    const msg = coUnwrap(m, this._peer);
    if (!msg) return;
    if (msg.type === 'view') {
      const joined = this._tracker.track(msg.peer, {
        range: { from: msg.from, to: msg.to },
        name: msg.name,
      });
      c._invalidate();
      if (joined) {
        const p = this._tracker.peers.get(msg.peer);
        this._fire('peers', {
          peers: this._tracker.list(),
          joined: [p ? { ...p, range: p.range && { ...p.range } } : { id: msg.peer }],
          left: [],
        });
      }
      return;
    }
    if (msg.type === 'bye') {
      const left = this._tracker.drop(msg.peer);
      if (left) this._fire('peers', { peers: this._tracker.list(), joined: [], left: [left] });
      c._invalidate();
      return;
    }
    if (msg.type !== 'cross') return;
    if (msg.time == null) {
      if (c._ghost) {
        c._ghost = null;
        clearTimeout(c._ghostTimer);
        c._invalidate();
      }
      return;
    }
    const d = c.data;
    if (!isNum(msg.time) || !d || !d.length) return;
    c._ghost = {
      index: indexForTime(d, msg.time),
      yFrac: isNum(msg.yFrac) ? clamp(msg.yFrac, 0, 1) : null,
      at: Date.now(),
    };
    clearTimeout(c._ghostTimer);
    c._ghostTimer = setTimeout(() => {
      c._ghost = null;
      c._invalidate();
    }, 2500);
    c._invalidate();
  }

  _fire(name, detail) {
    const c = this._chart;
    if (c && typeof c.dispatchEvent === 'function') {
      c.dispatchEvent(new CustomEvent('wick:' + name, { detail }));
    }
  }

  /* ---------------- the renderer (a plugin layer since 2.0) ---------------- */

  /** Peer viewport bands along the top of the plot + the dashed ghost
   *  crosshair of a peer's pointer — ported from the core renderer. */
  _render(api) {
    const c = this._chart;
    if (!c) return;
    const { ctx, layout: ly, palette: pal, data: d, timeToX } = api;
    if (!ly || !d || !d.length) return;
    const peers = this._tracker ? this._tracker.list().slice(0, 4) : [];
    if (peers.length) {
      ctx.save();
      ctx.font = api.pillFont || '600 11px ui-sans-serif, system-ui, sans-serif';
      for (let row = 0; row < peers.length; row++) {
        const p = peers[row];
        if (!p.range) continue;
        const cols = pal.overlay || [];
        const col = cols[(row + 1) % Math.max(cols.length, 1)] || pal.accent;
        const x0 = timeToX(p.range.from);
        const x1 = timeToX(p.range.to);
        if (x0 == null || x1 == null) continue;
        const y = ly.main.y0 + 2 + row * 5;
        const cx0 = Math.max(Math.min(x0, x1), 0);
        const cx1 = Math.min(Math.max(x0, x1), ly.plotRight);
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = col;
        ctx.fillRect(cx0, y, Math.max(cx1 - cx0, 3), 3);
        if (cx1 - cx0 > 44) {
          ctx.globalAlpha = 0.95;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(p.name || p.id, cx0 + 3, y + 4);
        }
      }
      ctx.restore();
    }
    const g = c._ghost;
    if (g) {
      const bar = d[Math.max(0, Math.min(d.length - 1, g.index))];
      const gx = bar ? timeToX(bar.time) : null;
      const gxVisible = gx != null && gx >= 0 && gx <= ly.plotRight;
      ctx.save();
      ctx.strokeStyle = pal.accent;
      ctx.globalAlpha = 0.7;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      if (gxVisible) {
        const cx = Math.round(gx) + 0.5;
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, ly.main.y0 + ly.main.h);
      }
      if (g.yFrac != null) {
        const gy = Math.round(ly.main.y0 + g.yFrac * ly.main.h) + 0.5;
        ctx.moveTo(0, gy);
        ctx.lineTo(ly.plotRight, gy);
        if (gxVisible) {
          ctx.fillStyle = pal.accent;
          ctx.beginPath();
          ctx.arc(gx, ly.main.y0 + g.yFrac * ly.main.h, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }
}
