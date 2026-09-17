/**
 * wickchart-narrator/core — the pure half of the guided-playback package:
 * the bar-walk timeline analyzer, scene validation, the camera easing and
 * the price→pitch mapping. No DOM, no chart — data in / data out, usable
 * from a worker or a backtest.
 *
 * The analyzer primitives (detectAnnotations, calcRSI, the overlay/scenario/
 * risk-plan normalizers) are imported from wickchart/core rather than
 * duplicated — they power the core annotations overlay too and must never
 * drift. narrateWindow itself lives here: until 2.0 the core entry carries
 * an identical copy behind chart.narrate(); this one is the home it moves
 * into (see ROADMAP-V2.md — prepare additively, cut atomically).
 */

import {
  calcRSI,
  detectAnnotations,
  normalizeOverlays,
  normalizeScenario,
  normalizeRiskPlan,
  SERIES_TYPES,
  toMs,
} from 'wickchart/core';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Turn a bar window into an ordered story: the annotation events (pivot
 * highs/lows, volume spikes, gaps, RSI divergences) plus derived **legs** —
 * the move between consecutive opposite pivots ("+12.4% over 38 bars").
 * The timeline drives the bar-walk player and any caption UI.
 *
 * @param {import('wickchart/core').Bar[]} bars full dataset
 * @param {number} i0 first index of the window
 * @param {number} i1 last index of the window
 * @param {{pivot?: number, volMult?: number, gapMult?: number, rsiPeriod?: number}} [opts]
 *        pivot window defaults to 8 (denser than the annotations overlay's 20)
 * @returns {{i: number, time: number, type: string, side: string, note: string,
 *            legPct?: number, legBars?: number}[]} sorted by index, capped at 60
 */
export function narrateWindow(bars, i0, i1, opts = {}) {
  if (!bars.length || i0 < 0 || i1 < i0 || i1 >= bars.length) return [];
  const rsi = calcRSI(bars.map((b) => b.close), Math.min(50, Math.max(2, +opts.rsiPeriod || 14)));
  const ann = detectAnnotations(bars, i0, i1, rsi, {
    pivot: opts.pivot ?? 8,
    volMult: opts.volMult,
    gapMult: opts.gapMult,
  });
  // legs: the move between consecutive opposite pivots, stamped at the
  // ending pivot so a walk player can speak it as it arrives
  const pivots = ann
    .filter((a) => a.type === 'pivothigh' || a.type === 'pivotlow')
    .sort((a, b) => a.i - b.i);
  const legs = [];
  for (let k = 1; k < pivots.length; k++) {
    const a = pivots[k - 1];
    const b = pivots[k];
    if (a.type === b.type) continue;
    const pa = a.type === 'pivothigh' ? bars[a.i].high : bars[a.i].low;
    const pb = b.type === 'pivothigh' ? bars[b.i].high : bars[b.i].low;
    if (!(pa > 0) || !Number.isFinite(pb)) continue;
    const pct = ((pb - pa) / pa) * 100;
    legs.push({
      type: 'leg',
      side: pct >= 0 ? 'high' : 'low',
      i: b.i,
      note: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% over ${b.i - a.i} bars`,
      legPct: Math.round(pct * 100) / 100,
      legBars: b.i - a.i,
    });
  }
  return [...ann, ...legs]
    .sort((a, b) => a.i - b.i)
    .slice(0, 60)
    .map((e) => ({ ...e, time: bars[e.i].time }));
}

/** Smoothest cheap easing for viewport pans: slow in, slow out. */
export function easeInOutCubic(t) {
  const x = Math.min(Math.max(+t || 0, 0), 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Validate one story scene. Every field is optional except that a scene
 * must be an object; omitted fields simply don't change that aspect of the
 * chart when played. `scenario`/`riskPlan` use a 'clear' sentinel for
 * explicit "remove it" (null input means clear too when the KEY is present).
 *
 *   { title: 'The breakout', note: 'What happened…',
 *     range: { from, to },          // times (s or ms) — the camera pans there
 *     indicators: 'sma:20 rsi:14',  // optional indicator string
 *     type: 'candles',              // optional series type
 *     overlays: [...],              // optional zones/levels (normalizeOverlays)
 *     scenario: {...} | null,       // set / clear a scenario
 *     riskPlan: {...} | null,       // set / clear a risk plan
 *     dwell: 2200 }                 // ms to hold after the pan (500–30000)
 *
 * @returns {object|null} normalized scene, or null for non-objects
 */
export function normalizeScene(scene) {
  if (!scene || typeof scene !== 'object') return null;
  const out = {
    title: scene.title != null ? String(scene.title).slice(0, 60) : '',
    note: scene.note != null ? String(scene.note).slice(0, 200) : '',
    dwell: Math.min(Math.max(Math.round(+scene.dwell || 2200), 500), 30000),
  };
  if (scene.range && Number.isFinite(+scene.range.from) && Number.isFinite(+scene.range.to)) {
    out.range = { from: +scene.range.from, to: +scene.range.to };
  }
  if (scene.indicators != null) {
    const s = String(scene.indicators).trim();
    if (s) out.indicators = s.slice(0, 200);
  }
  if (scene.type != null && SERIES_TYPES.includes(scene.type)) out.type = scene.type;
  if (scene.overlays != null) {
    const ovs = normalizeOverlays(scene.overlays);
    if (ovs.length) out.overlays = ovs;
  }
  if ('scenario' in scene) {
    if (scene.scenario == null) out.scenario = 'clear';
    else {
      const sc = normalizeScenario(scene.scenario);
      if (sc) out.scenario = sc;
    }
  }
  if ('riskPlan' in scene) {
    if (scene.riskPlan == null) out.riskPlan = 'clear';
    else {
      const rp = normalizeRiskPlan(scene.riskPlan);
      if (rp) out.riskPlan = rp;
    }
  }
  return out;
}

/**
 * Validate a whole story: normalize each scene, drop junk, cap at 20.
 * @returns {object[]} possibly empty
 */
export function sceneList(story) {
  if (!Array.isArray(story)) return [];
  const out = [];
  for (const s of story) {
    const n = normalizeScene(s);
    if (n) out.push(n);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Map a price to a sonification frequency over the visible scale.
 * Logarithmic scales map through log-space; result clamped to [lo, hi] Hz.
 * @param {number} price
 * @param {{min: number, max: number, useLog?: boolean}} scale
 * @param {number} [freqLo=180]
 * @param {number} [freqHi=880]
 * @returns {number} frequency in Hz
 */
export function priceToFreq(price, scale, freqLo = 180, freqHi = 880) {
  if (!scale || !(scale.max > scale.min)) return (freqLo + freqHi) / 2;
  let t;
  if (scale.useLog) {
    // scale.min/max are already log10-transformed in this mode
    t = (Math.log10(Math.max(price, 1e-12)) - scale.min) / (scale.max - scale.min || 1);
  } else {
    t = (price - scale.min) / (scale.max - scale.min);
  }
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return freqLo + t * (freqHi - freqLo);
}

/** Seconds / milliseconds / Date → milliseconds (same rule as the chart). */
export const timeToMs = (t) => (t instanceof Date ? t.getTime() : isNum(t) ? toMs(t) : Date.now());

/** Lower-bound index for `time` in ascending bars (same rule as the chart). */
export function indexForTime(bars, time) {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
