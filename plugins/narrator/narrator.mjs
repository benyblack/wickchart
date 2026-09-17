/**
 * wickchart-narrator — guided playback for wickchart, as a plugin: the
 * bar-walk narrator (a timeline of pivots, spikes, gaps and legs), the walk
 * player that slides the viewport through history announcing each event, the
 * ear-based sonification (`sonify` attribute + playRange()), and story mode
 * (capture chart state as scenes, play them back as a narrated tour).
 *
 *   import { attachNarrator } from 'wickchart-narrator';
 *
 *   const narrator = attachNarrator(chart);
 *   chart.narrate();               // timeline for the visible range
 *   chart.walk({ from: 0 });       // viewport replay, wick:walk narrates
 *   chart.playRange();             // ~4s pitch sweep of the visible bars
 *   const story = [chart.captureScene('Overview'), …];
 *   chart.playStory(story, { loop: true });
 *   narrator.detach();
 *
 * Calls keep their core shape: the familiar methods are installed on the
 * instance, so code written against chart.narrate() / playStory() works with
 * one added import. Until 2.0 the core entry still ships its own identical
 * methods; attaching simply shadows them (see ROADMAP-V2.md).
 *
 * Element contract — beyond the public API (data, getVisibleRange(),
 * setAttribute, setOverlays, scenario / riskPlan accessors, wick:* events)
 * the camera drives a small set of documented internals: _view / _ly /
 * _auto / _connected, _clampView(), _invalidate(), _emitRange(),
 * _minSpacing(), _renderBars(), _lastScale, _xFor(), _hover and
 * _emitCrosshair(). Core calls the installed _maybeSonify() / _stopPlayback()
 * hooks, so crosshair sonification and touch-interrupts keep working.
 */

import {
  narrateWindow,
  sceneList,
  easeInOutCubic,
  priceToFreq,
  timeToMs,
  indexForTime,
} from './core.mjs';

export { narrateWindow, normalizeScene, sceneList, easeInOutCubic, priceToFreq } from './core.mjs';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const INSTALLED = [
  'narrate', 'walk', 'stopWalk', 'playRange',
  'captureScene', 'getStory', 'playStory', 'stopStory',
  '_maybeSonify', '_stopPlayback',
];

export function attachNarrator(chart) {
  return new Narrator(chart);
}

export class Narrator {
  /**
   * @param {object} chart a <wick-chart> (or anything with its data / range /
   *   event surface) to install the narrator methods on
   */
  constructor(chart) {
    if (
      !chart ||
      typeof chart.getVisibleRange !== 'function' ||
      typeof chart.dispatchEvent !== 'function' ||
      typeof chart.data === 'undefined'
    ) {
      throw new TypeError('attachNarrator(chart): the chart element is required');
    }
    if (chart._wickNarrator) return chart._wickNarrator; // idempotent attach
    this._chart = chart;
    // playback state lives on the controller, not the chart
    this._walkTimer = 0;
    this._storyToken = 0;
    this._story = null;
    this._playToken = 0; // invalidates a running playRange crosshair ride
    this._lastToneIdx = -1; // crosshair sonification dedupe
    this._actx = null;
    for (const m of INSTALLED) chart[m] = this[m].bind(this);
    chart._wickNarrator = this;
  }

  detach() {
    const c = this._chart;
    if (!c) return;
    this.stopWalk(true);
    this.stopStory(true);
    for (const m of INSTALLED) {
      try {
        delete c[m];
      } catch (_) {}
    }
    try {
      delete c._wickNarrator;
    } catch (_) {}
    this._chart = null;
  }

  /* ---------------- narrated timeline ---------------- */

  /**
   * Narrated timeline for a window (default: the visible range) — pivot
   * highs/lows, volume spikes, gaps, RSI divergences plus derived legs
   * ("+12.4% over 38 bars"), sorted by index. Pure data, perfect for
   * caption UIs or the walk player.
   *   chart.narrate();             // whole dataset
   *   chart.narrate({ from, to }); // times in ms (s accepted)
   * @param {{from?: number, to?: number}} [range]
   */
  narrate(range) {
    const c = this._chart;
    const d = c && c.data;
    if (!d || !d.length) return [];
    let i0 = 0;
    let i1 = d.length - 1;
    if (range && isNum(range.from) && isNum(range.to)) {
      i0 = indexForTime(d, timeToMs(range.from));
      i1 = indexForTime(d, timeToMs(range.to));
      if (i0 > i1) [i0, i1] = [i1, i0];
    }
    return narrateWindow(d, i0, i1);
  }

  /* ---------------- walk player ---------------- */

  /**
   * Walk the chart through history like a story: the viewport slides from
   * `from` to `to` while `wick:walk` events announce every step and the
   * narrator's events (spikes, gaps, pivots, legs) as they're crossed. Any
   * user interaction — pointer, wheel, keys, double-click — stops it.
   *   chart.walk({ from: 0, to: 500, speed: 120, step: 10 });
   *   // detail: { phase: 'step'|'end'|'stop', index, events: [...], from, to }
   * @param {{from?: number, to?: number, speed?: number, step?: number}} [opts]
   *        from/to are bar indices (default: last ~500 bars → the end)
   * @returns {boolean} true when the walk started
   */
  walk(opts = {}) {
    const c = this._chart;
    if (!c) return false;
    this.stopWalk(true);
    const d = c.data;
    if (!d || !d.length || !c._connected) return false;
    const to = clamp(Math.round(+opts.to || d.length - 1), 0, d.length - 1);
    const from = clamp(Math.round(opts.from != null ? +opts.from : Math.max(0, to - 500)), 0, to);
    const span = to - from + 1;
    // window width: the current viewport, but never more than ~⅓ of the
    // span (a fully zoomed-out chart would otherwise start at `to`)
    const widthBars = clamp(
      Math.min(
        c._ly ? Math.round(c._ly.plotRight / c._view.spacing) : 120,
        Math.max(10, Math.ceil(span / 3))
      ),
      10,
      span
    );
    const events = narrateWindow(d, from, to, { pivot: 8 });
    const speed = clamp(Math.round(+opts.speed || 120), 16, 2000);
    const step = clamp(Math.round(+opts.step || Math.max(1, Math.round(widthBars / 12))), 1, 500);
    let cursor = Math.min(from + widthBars - 1, to);
    let ev = 0;
    let ended = false;
    const tick = () => {
      if (ended) return;
      c._auto = false;
      c._view.rightIndex = cursor;
      c._clampView();
      c._invalidate();
      c._emitRange();
      const hits = [];
      while (ev < events.length && events[ev].i <= cursor) hits.push(events[ev++]);
      this._fire('walk', { phase: 'step', index: cursor, events: hits, from, to });
      if (cursor >= to) {
        ended = true;
        clearInterval(this._walkTimer);
        this._walkTimer = 0;
        this._fire('walk', { phase: 'end', index: cursor, events: [], from, to });
      } else {
        cursor = Math.min(cursor + step, to);
      }
    };
    this._walkTimer = setInterval(tick, speed);
    tick(); // first step lands immediately
    return true;
  }

  /**
   * Stop the running walk (if any). Fires a final `wick:walk`
   * { phase: 'stop' } unless called internally.
   */
  stopWalk(silent) {
    if (!this._walkTimer) return;
    clearInterval(this._walkTimer);
    this._walkTimer = 0;
    if (!silent) this._fire('walk', { phase: 'stop' });
  }

  /* ---------------- sonification ---------------- */

  /** Lazily-created shared AudioContext (enable within a user gesture). */
  _audio() {
    if (this._actx) return this._actx;
    const AC =
      typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try {
      this._actx = new AC();
    } catch (_) {
      this._actx = null;
    }
    return this._actx;
  }

  /** Short sine blip; `when` schedules against AudioContext time. */
  _tone(freq, dur = 0.14, when = 0) {
    const ctx = this._audio();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = when || ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  /** The bars as rendered (heikin reuses its cached transform). */
  _bars() {
    const c = this._chart;
    return typeof c._renderBars === 'function' ? c._renderBars() : c.data;
  }

  /** One tone for a bar's close, pitched by its position on the y-scale. */
  _sonifyBar(i) {
    const c = this._chart;
    const d = this._bars();
    if (!d || !d.length || !c._lastScale) return;
    const b = d[clamp(i, 0, d.length - 1)];
    if (!b) return;
    this._tone(priceToFreq(b.close, c._lastScale));
  }

  /**
   * One tone per crosshair bar change (dedupes y-only moves). Installed as
   * an own property so the core crosshair path calls this version; the
   * `sonify` attribute is the switch — read live, no cached copy.
   */
  _maybeSonify(idx) {
    const c = this._chart;
    if (!c || typeof c.getAttribute !== 'function') return;
    const v = c.getAttribute('sonify');
    if (v == null || v === 'false') return;
    if (this._lastToneIdx === idx) return;
    this._lastToneIdx = idx;
    this._sonifyBar(idx);
  }

  /**
   * Play the visible range as a pitch sweep (~4s), riding the crosshair —
   * the audible equivalent of running your eye along the price line.
   */
  playRange() {
    const c = this._chart;
    if (!c || !c.data || !c.data.length || !c._ly) return;
    const ctx = this._audio();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const d = this._bars();
    const count = Math.max(2, Math.round(c._ly.plotRight / c._view.spacing));
    const i0 = clamp(Math.floor(c._view.rightIndex - count) - 1, 0, d.length - 1);
    const i1 = clamp(Math.ceil(c._view.rightIndex), 0, d.length - 1);
    if (i1 - i0 < 2) return;
    const N = Math.min(120, i1 - i0 + 1);
    const stepMs = Math.min(70, Math.max(24, 4000 / N));
    const t0 = ctx.currentTime + 0.05;
    for (let k = 0; k < N; k++) {
      const i = Math.round(i0 + ((i1 - i0) * k) / (N - 1));
      const b = d[i];
      if (!b) continue;
      this._tone(priceToFreq(b.close, c._lastScale), (stepMs / 1000) * 0.9, t0 + (k * stepMs) / 1000);
    }
    // ride the crosshair along the sweep for sighted users
    const token = ++this._playToken;
    let k = 0;
    const timer = setInterval(() => {
      if (token !== this._playToken || !c._connected) {
        clearInterval(timer);
        return;
      }
      if (k >= N) {
        clearInterval(timer);
        c._hover = null;
        c._emitCrosshair(null);
        c._invalidate();
        return;
      }
      const i = Math.round(i0 + ((i1 - i0) * k) / (N - 1));
      c._hover = { index: i, x: c._xFor(i), y: c._ly ? c._ly.main.h * 0.5 : 0 };
      c._invalidate();
      k++;
    }, stepMs);
  }

  /* ---------------- story mode ---------------- */

  /**
   * Capture the current chart state as a story scene: view, series type,
   * indicators, overlays, scenario and risk plan, plus a title/note.
   * Build guided tours by capturing several and playing them back.
   *   const story = [
   *     chart.captureScene('Overview', 'The full picture'),
   *     { title: 'The breakout', range: { from, to }, indicators: 'sma:20' },
   *   ];
   *   chart.playStory(story);
   * @param {string} [title]
   * @param {string} [note]
   * @returns {object} scene (plain data — snapshot of the moment)
   */
  captureScene(title, note) {
    const c = this._chart;
    const scene = {
      title: title != null ? String(title).slice(0, 60) : '',
      note: note != null ? String(note).slice(0, 200) : '',
      range: c.getVisibleRange() || undefined,
      type: c.getAttribute('type') || 'candles',
      indicators: c.getAttribute('indicators') || null,
    };
    const ovs = c.overlays;
    if (ovs && ovs.length) scene.overlays = ovs;
    const sc = c.scenario;
    if (sc) scene.scenario = sc;
    const rp = c.riskPlan;
    if (rp) scene.riskPlan = rp;
    return scene;
  }

  /** @returns {object[]|null} a copy of the last played story */
  getStory() {
    return this._story ? this._story.map((s) => ({ ...s })) : null;
  }

  /**
   * Play a story: each scene applies its state (type / indicators /
   * overlays / scenario / risk plan — set or clear), the camera eases to
   * its range, then holds for its dwell. `wick:story` events narrate:
   *   { phase: 'scene' | 'end' | 'stop', index, total, scene, title, note }
   * Any user interaction — pointer, wheel, keys, double-click — stops it.
   * @param {object[]} story scenes (invalid entries dropped, max 20)
   * @param {{dwell?: number, panMs?: number, loop?: boolean}} [opts]
   *        panMs clamps 100–5000 (default 900); loop replays forever
   * @returns {boolean} true when playback started
   */
  playStory(story, opts = {}) {
    this.stopStory(true);
    const c = this._chart;
    const scenes = sceneList(story);
    if (!c || !scenes.length || !c.data || !c.data.length || !c._connected) return false;
    const token = ++this._storyToken;
    this._story = scenes;
    const panMs = clamp(Math.round(+opts.panMs || 900), 100, 5000);
    const loop = opts.loop === true;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const run = async () => {
      let idx = 0;
      while (token === this._storyToken) {
        const sc = scenes[idx];
        this._fire('story', {
          phase: 'scene', index: idx, total: scenes.length,
          scene: sc, title: sc.title, note: sc.note,
        });
        this._applyScene(sc);
        const target = this._sceneTarget(sc);
        if (target) await this._storyTween(target, panMs, token);
        if (token !== this._storyToken) return;
        await wait(sc.dwell);
        if (token !== this._storyToken) return;
        idx++;
        if (idx >= scenes.length) {
          if (loop) idx = 0;
          else {
            this._fire('story', { phase: 'end', index: idx - 1, total: scenes.length });
            return;
          }
        }
      }
    };
    run();
    return true;
  }

  /**
   * Stop story playback (if running). Fires a final `wick:story`
   * { phase: 'stop' } unless called internally.
   */
  stopStory(silent) {
    if (!this._storyToken) return;
    this._storyToken = 0;
    if (!silent) this._fire('story', { phase: 'stop' });
  }

  /** Apply a scene's state (only the fields it carries). */
  _applyScene(sc) {
    const c = this._chart;
    if (sc.type) c.setAttribute('type', sc.type);
    if (sc.indicators != null) c.setAttribute('indicators', sc.indicators);
    if (sc.overlays) c.setOverlays(sc.overlays);
    if (sc.scenario === 'clear') c.clearScenario();
    else if (sc.scenario) c.setScenario(sc.scenario);
    if (sc.riskPlan === 'clear') c.clearRiskPlan();
    else if (sc.riskPlan) c.setRiskPlan(sc.riskPlan);
  }

  /** Map a scene's time range to bar indices (null when not applicable). */
  _sceneTarget(sc) {
    const d = this._chart && this._chart.data;
    if (!sc.range || !d || !d.length) return null;
    let i0 = indexForTime(d, timeToMs(sc.range.from));
    let i1 = indexForTime(d, timeToMs(sc.range.to));
    if (i0 > i1) [i0, i1] = [i1, i0];
    return i1 - i0 >= 2 ? { i0, i1 } : null;
  }

  /** Ease the viewport to { i0, i1 } over `ms`; resolves early if the
   *  token changes (superseded or stopped). rAF when available. */
  _storyTween(target, ms, token) {
    const c = this._chart;
    const ly = c && c._ly;
    const d = c && c.data;
    if (!ly || !d.length) return Promise.resolve();
    const MAX_SP = (c.constructor && c.constructor._MAX_SP) || 90;
    const sp1 = clamp(ly.plotRight / (target.i1 - target.i0), c._minSpacing(), MAX_SP);
    const from = { right: c._view.rightIndex, sp: c._view.spacing };
    const to = { right: target.i1, sp: sp1 };
    const t0 = performance.now();
    c._auto = false;
    return new Promise((resolve) => {
      const step = () => {
        if (token !== this._storyToken) return resolve();
        const e = easeInOutCubic(Math.min(1, (performance.now() - t0) / ms));
        c._view.rightIndex = from.right + (to.right - from.right) * e;
        c._view.spacing = from.sp + (to.sp - from.sp) * e;
        c._clampView();
        c._invalidate();
        c._emitRange();
        if (e >= 1) resolve();
        else if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
        else setTimeout(step, 16);
      };
      step();
    });
  }

  /* ---------------- plumbing ---------------- */

  /** Interrupt narrated playback (walk / story) on user input. Installed as
   *  an own property so every core input path (pointer / wheel / key /
   *  double-click) routes here while the narrator is attached. */
  _stopPlayback() {
    if (this._walkTimer) this.stopWalk();
    if (this._storyToken) this.stopStory();
  }

  _fire(name, detail) {
    const c = this._chart;
    if (c && typeof c.dispatchEvent === 'function') {
      c.dispatchEvent(new CustomEvent('wick:' + name, { detail }));
    }
  }
}
