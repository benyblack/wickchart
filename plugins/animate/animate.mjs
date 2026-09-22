/**
 * wickchart-animate — live-price easing as a wickchart plugin: ticks on the
 * forming bar glide to their new close over a short ease instead of
 * teleporting. Runs entirely on the public data API (chart.update), wrapped
 * on the instance so every tick source — app code, <wick-feed>, paper — is
 * eased without wiring. Eased frames replace the forming bar with an
 * interpolated close (high/low clamped so the body never escapes its wick);
 * the final frame always writes the true bar. Attach once per chart.
 *
 *   import { attachAnimate } from 'wickchart-animate';
 *   const anim = attachAnimate(chart, { duration: 180 });   // ms, 0 = off
 *   anim.detach();
 *
 * opts: duration (default 180, 0 disables), easing ('ease-out' | 'linear' |
 * fn(t)), volume (ease volume too; default false).
 * prefers-reduced-motion is a hard passthrough.
 *
 * Caveat: eased frames are live ticks to the chart, so alert predicates and
 * online indicator recompute see interpolated closes — the linear path
 * between two real closes, at most `duration` of firing-time skew.
 */

const EASINGS = {
  'ease-out': (t) => 1 - Math.pow(1 - t, 3),
  linear: (t) => t,
};
const DEF_DURATION = 180;
const DUR_MAX = 1500;

const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(() => fn(Date.now()), 16));
const caf = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

export function attachAnimate(chart, opts = {}) {
  return new Animate(chart, opts);
}

export class Animate {
  constructor(chart, opts = {}) {
    if (!chart || typeof chart.update !== 'function' || !('data' in chart)) {
      throw new TypeError('attachAnimate(chart): the chart element is required');
    }
    // double-attach guard first — validate before side effects (the mq
    // listener below must not leak on a failed attach)
    if (chart.update && chart.update._wickAnimate) {
      throw new TypeError('attachAnimate(chart): an animate plugin is already attached to this chart');
    }
    this._chart = chart;
    const dur = opts.duration == null ? DEF_DURATION : Number(opts.duration);
    this._dur = Math.max(0, Math.min(DUR_MAX, Number.isFinite(dur) ? dur : DEF_DURATION));
    this._easeFn = typeof opts.easing === 'function' ? opts.easing : (EASINGS[opts.easing] || EASINGS['ease-out']);
    this._volume = opts.volume === true;
    this._es = null; // the active ease: { time, from, to, real, cur, volFrom, volTo, curVol, data, t0 }
    this._rafId = 0;
    this._detached = false;
    this._mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this._onMq = null;
    if (this._mq) {
      this._onMq = () => { if (this._mq.matches) this._flush(); if (this._chart.isConnected === false) this.detach(); };
      if (this._mq.addEventListener) this._mq.addEventListener('change', this._onMq);
      else if (this._mq.addListener) this._mq.addListener(this._onMq);
    }
    // wrap update on the instance: every tick source funnels through it
    this._orig = chart.update;
    this._hadOwn = Object.prototype.hasOwnProperty.call(chart, 'update');
    this._prevOwn = this._hadOwn ? chart.update : null;
    this._wrap = (bar) => this._tick(bar);
    this._wrap._wickAnimate = this;
    chart.update = this._wrap;
  }

  detach() {
    const c = this._chart;
    this._detached = true;
    if (c.update === this._wrap) {
      if (this._hadOwn) c.update = this._prevOwn; else delete c.update;
    }
    this._flush();
    if (this._mq && this._onMq) {
      if (this._mq.removeEventListener) this._mq.removeEventListener('change', this._onMq);
      else if (this._mq.removeListener) this._mq.removeListener(this._onMq);
    }
  }

  /* ---------------- internals ---------------- */

  _reduced() { return !!this._mq && !!this._mq.matches; }

  _pass(bar) { return this._orig.call(this._chart, bar); }

  _tick(bar) {
    if (this._detached) return this._pass(bar);
    if (this._dur <= 0 || this._reduced() || !bar) return this._pass(bar);
    // the chart's normalizer resolves { value } → close (the documented
    // line-series input form); classify on the same value or every
    // value-form tick reads as invalid and line charts never animate
    const c = bar.close != null && bar.close !== '' ? bar.close : bar.value;
    if (c == null || c === '' || !isFinite(Number(c))) return this._pass(bar);
    // the chart normalizes seconds → ms inside update() (its 1e11 cutoff);
    // classify against the normalized value or a seconds tick reads as a
    // backfill and silently skips the ease
    const t = bar.time instanceof Date ? bar.time.getTime() : bar.time < 1e11 ? bar.time * 1000 : bar.time;
    if (!Number.isFinite(t)) return this._pass(bar);
    const d = this._chart.data;
    const last = d && d[d.length - 1];
    if (!last || t > last.time) {
      // a new bar is a fact: flush any active ease to its true bar, then append
      this._flush();
      return this._pass(bar);
    }
    if (t < last.time) {
      // backfill / historical correction: a fact, never eased; the forming
      // bar is untouched, so an active ease keeps running
      return this._pass(bar);
    }
    // forming-bar tick: start (or retarget) the ease from the current display
    const es = this._es;
    const from = es && es.time === t ? es.cur : last.close;
    const volFrom = this._volume && es && es.time === t && typeof es.curVol === 'number'
      ? es.curVol
      : (typeof last.volume === 'number' ? last.volume : Number(bar.volume));
    this._es = {
      time: t,
      from,
      to: Number(c),
      real: { ...bar }, // snapshot: the caller may reuse/mutate its bar object
      cur: from,
      volFrom,
      volTo: Number(bar.volume),
      curVol: volFrom,
      data: d, // the array the ease belongs to — setData builds a fresh one
      t0: null,
    };
    if (!this._rafId) this._rafId = raf((t) => this._frame(t));
    return undefined;
  }

  _frame(t) {
    this._rafId = 0;
    const es = this._es;
    if (!es) return; // stale frame after flush/detach
    const d = this._chart.data;
    const last = d && d[d.length - 1];
    // data moved: a setData replaces the array even when the new dataset
    // ends at the same candle time (symbol switch on one timeframe) — a
    // timestamp check alone can't see that
    if (d !== es.data || !last || last.time !== es.time) { this._es = null; return; }
    if (es.t0 == null) es.t0 = t;
    const k = (t - es.t0) / this._dur;
    if (k >= 1) {
      this._es = null;
      return this._pass(es.real); // the final frame is always the true bar
    }
    es.cur = es.from + (es.to - es.from) * this._easeFn(k);
    const b = { ...es.real, close: es.cur };
    // `closed` is the feed's "this candle is final" flag: the chart advances
    // its closed-bar cursor and evaluates close-mode alerts against a closed
    // front bar, so an interpolated frame must never carry it — only the
    // final exact write (es.real) may.
    delete b.closed;
    if (this._volume && isFinite(es.volFrom) && isFinite(es.volTo)) {
      es.curVol = es.volFrom + (es.volTo - es.volFrom) * this._easeFn(k);
      b.volume = es.curVol;
    }
    b.high = Math.max(es.real.high, es.cur);
    b.low = Math.min(es.real.low, es.cur);
    this._pass(b);
    if (!this._rafId) this._rafId = raf((tt) => this._frame(tt));
  }

  /** Write the true bar of an active ease (detach / reduced-motion / append). */
  _flush() {
    const es = this._es;
    if (!es) return;
    this._es = null;
    if (this._rafId) caf(this._rafId);
    this._rafId = 0;
    const d = this._chart.data;
    const last = d && d[d.length - 1];
    if (d === es.data && last && last.time === es.time) this._pass(es.real);
  }
}
