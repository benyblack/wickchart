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

const raf = typeof requestAnimationFrame === 'function'
  ? (fn) => requestAnimationFrame(fn)
  : (fn) => setTimeout(() => fn(Date.now()), 16);
const caf = typeof cancelAnimationFrame === 'function'
  ? (id) => cancelAnimationFrame(id)
  : clearTimeout;

export function attachAnimate(chart, opts = {}) {
  return new Animate(chart, opts);
}

export class Animate {
  constructor(chart, opts = {}) {
    if (!chart || typeof chart.update !== 'function' || !('data' in chart)) {
      throw new TypeError('attachAnimate(chart): the chart element is required');
    }
    this._chart = chart;
    this._dur = Math.max(0, Math.min(DUR_MAX, Number(opts.duration) || DEF_DURATION));
    this._easeFn = typeof opts.easing === 'function' ? opts.easing : (EASINGS[opts.easing] || EASINGS['ease-out']);
    this._volume = opts.volume === true;
    this._es = null; // the active ease: { time, from, to, real, cur, t0 }
    this._rafId = 0;
    this._mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this._onMq = null;
    if (this._mq) {
      this._onMq = () => { if (this._mq.matches) this._flush(); };
      if (this._mq.addEventListener) this._mq.addEventListener('change', this._onMq);
      else if (this._mq.addListener) this._mq.addListener(this._onMq);
    }
    // wrap update on the instance: every tick source funnels through it
    this._orig = chart.update;
    this._hadOwn = Object.prototype.hasOwnProperty.call(chart, 'update');
    this._prevOwn = this._hadOwn ? chart.update : null;
    chart.update = (bar) => this._tick(bar);
  }

  detach() {
    const c = this._chart;
    this._flush();
    if (this._mq && this._onMq) {
      if (this._mq.removeEventListener) this._mq.removeEventListener('change', this._onMq);
      else if (this._mq.removeListener) this._mq.removeListener(this._onMq);
    }
    if (this._hadOwn) c.update = this._prevOwn; else delete c.update;
  }

  /* ---------------- internals ---------------- */

  _reduced() { return !!this._mq && !!this._mq.matches; }

  _pass(bar) { return this._orig.call(this._chart, bar); }

  _tick(bar) {
    if (this._dur <= 0 || this._reduced() || !bar || !isFinite(Number(bar.close))) {
      return this._pass(bar);
    }
    return this._pass(bar); // easing branches land in Tasks 6–9
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
    if (last && last.time === es.time) this._pass(es.real);
  }
}
