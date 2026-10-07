/**
 * wickchart-briefing — one command that explains the chart: the visible
 * window synthesized into a structured markdown briefing (tape summary,
 * candlestick signal census, smart annotations, narrate timeline) —
 * composition of parts that already existed, computed locally.
 *
 *   import { attachBriefing } from 'wickchart-briefing';
 *   attachBriefing(chart);
 *
 *   const b = chart.briefing();      // the model: { markdown, summary, … }
 *   b.markdown;                      // the ready-to-paste document
 *   await chart.copyBriefing();      // …straight to the clipboard
 *
 * The attach installs chart.briefing() / chart.copyBriefing() on the
 * instance (shadowing nothing; detach() removes them again). The model is
 * briefingModel() from './core.mjs' — pure, unit-tested, usable from Node
 * without a chart.
 */

import { briefingModel } from './core.mjs';
import { barIndexForTime } from 'wickchart/core';

/**
 * Install chart.briefing() / chart.copyBriefing().
 * @param {object} chart a <wick-chart>
 * @param {{label?: string, kinds?: string[], maxEvents?: number,
 *   pivot?: number, volMult?: number, gapMult?: number}} [opts]
 * @returns {{briefing: (o?: object) => object|null,
 *   copyBriefing: (o?: object) => Promise<object>, detach: () => void}}
 */
export function attachBriefing(chart, opts = {}) {
  const build = (callOpts = {}) => {
    const d = chart && chart.data;
    if (!Array.isArray(d) || d.length < 2) return null;
    let i0 = 0;
    let i1 = d.length - 1;
    if (typeof chart.getVisibleRange === 'function') {
      const r = chart.getVisibleRange();
      const a = r ? barIndexForTime(d, r.from) : null;
      const b = r ? barIndexForTime(d, r.to) : null;
      if (a != null && b != null && b > a) {
        i0 = a;
        i1 = b;
      }
    }
    const dtMs = (d[i1].time - d[i0].time) / (i1 - i0);
    const label = (typeof chart.getAttribute === 'function' && chart.getAttribute('label')) ||
      opts.label || undefined;
    return briefingModel(d, i0, i1, { ...opts, ...callOpts, label, dtMs });
  };

  const copy = async (callOpts = {}) => {
    const m = build(callOpts);
    if (!m) throw new Error('copyBriefing: the chart needs data (2+ bars)');
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      throw new Error('copyBriefing requires a browser clipboard');
    }
    await navigator.clipboard.writeText(m.markdown);
    return m;
  };

  const had = { briefing: chart.briefing, copyBriefing: chart.copyBriefing };
  chart.briefing = build;
  chart.copyBriefing = copy;
  return {
    briefing: build,
    copyBriefing: copy,
    detach() {
      for (const key of ['briefing', 'copyBriefing']) {
        if (had[key] !== undefined) chart[key] = had[key];
        else delete chart[key];
      }
    },
  };
}
