/**
 * wickchart-briefing/core — the pure half of the briefing package: one
 * command's worth of composition, no DOM and no chart. The visible window
 * becomes a structured markdown briefing — the tape summary
 * (windowSummary: trend, volatility regime, highs/lows, notable events),
 * the candlestick signal census (wickchart-signals), the smart
 * annotations (gaps, spikes, divergences) and the narrate timeline with
 * its legs (wickchart-narrator) — "explain this chart" as a first-class
 * artifact.
 *
 * Every input is data that already existed: windowSummary, computeStats,
 * calcRSI and detectAnnotations from wickchart/core, detectSignals from
 * wickchart-signals/core, narrateWindow from wickchart-narrator/core.
 * This module only orchestrates and formats; nothing is re-derived, so
 * the briefing can never disagree with the chart it describes.
 */

import {
  windowSummary, detectAnnotations, calcRSI,
} from 'wickchart/core';
import { detectSignals, KIND_INFO } from 'wickchart-signals/core';
import { narrateWindow } from 'wickchart-narrator/core';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** UTC-stable `YYYY-MM-DD HH:MM` — deterministic across machines, which
 *  matters both for shared briefings and for the tests. */
export function fmtStamp(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

const dirWord = (d) => (d === 'bull' ? 'bullish' : d === 'bear' ? 'bearish' : 'neutral');

/**
 * Summarize the window's candlestick signals as a census plus the most
 * recent occurrences. Pure data; the markdown lives in briefingModel.
 * @param {Array<import('wickchart/core').Bar>} bars
 * @param {number} i0 @param {number} i1
 * @param {string[]} [kinds] subset for detectSignals (default: all)
 */
export function signalCensus(bars, i0, i1, kinds) {
  const all = detectSignals(bars, kinds);
  const inWin = all.filter((s) => s.i >= i0 && s.i <= i1);
  const counts = {};
  for (const s of inWin) {
    const key = `${dirWord(s.dir)} ${KIND_INFO[s.kind] ? KIND_INFO[s.kind].name : s.kind}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  const latest = inWin.slice(-3).reverse().map((s) => ({
    i: s.i, time: bars[s.i].time, kind: s.kind, dir: s.dir,
  }));
  return { total: inWin.length, counts, latest };
}

/**
 * Compose the whole briefing as data + markdown.
 * @param {Array<import('wickchart/core').Bar>} bars full dataset
 * @param {number} i0 first index of the window
 * @param {number} i1 last index of the window
 * @param {{label?: string, dtMs?: number, now?: number, maxEvents?: number,
 *   kinds?: string[], pivot?: number, volMult?: number, gapMult?: number}} [opts]
 * @returns {{title: string, generatedAt: number, window: object, summary: object,
 *   signals: object, annotations: Array, timeline: Array, markdown: string}|null}
 */
export function briefingModel(bars, i0, i1, opts = {}) {
  const summary = windowSummary(bars, i0, i1, { dtMs: opts.dtMs, label: opts.label });
  if (!summary) return null;

  const signals = signalCensus(bars, i0, i1, opts.kinds);
  const maxEvents = Number.isInteger(opts.maxEvents) && opts.maxEvents >= 0 ? opts.maxEvents : 8;
  const rsi = calcRSI(bars.map((b) => b.close), 14);
  const annotations = detectAnnotations(bars, i0, i1, rsi)
    .sort((a, b) => b.i - a.i)
    .slice(0, maxEvents)
    .map((a) => ({ i: a.i, time: bars[a.i].time, type: a.type, note: a.note }));
  const timeline = narrateWindow(bars, i0, i1, {
    pivot: opts.pivot, volMult: opts.volMult, gapMult: opts.gapMult,
  });

  const title = (summary.label || 'Chart') + ' — chart briefing';
  const generatedAt = isNum(opts.now) ? opts.now : Date.now();

  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`_${fmtStamp(summary.from)} → ${fmtStamp(summary.to)} · ${summary.bars} bars` +
    (summary.timeframe ? ` · ${summary.timeframe}` : '') +
    ` · generated ${fmtStamp(generatedAt)}_`);
  lines.push('');
  lines.push('## Tape');
  // windowSummary's own markdown, minus its header line (the briefing
  // header already carries label/bars/dates)
  for (const l of summary.text.split('\n').slice(1)) lines.push(l);
  lines.push('');
  lines.push('## Signals');
  if (signals.total) {
    lines.push(
      `${signals.total} candlestick signal${signals.total === 1 ? '' : 's'} in the window: ` +
      Object.entries(signals.counts).map(([k, n]) => `${n} ${k}`).join(', ') + '.');
    for (const s of signals.latest) {
      lines.push(`- latest: ${dirWord(s.dir)} ${KIND_INFO[s.kind] ? KIND_INFO[s.kind].name : s.kind} — ${fmtStamp(s.time)}`);
    }
  } else {
    lines.push('No engulfing, pin bar or inside-bar signals in the window.');
  }
  lines.push('');
  lines.push('## Annotations');
  if (annotations.length) {
    for (const a of annotations) lines.push(`- ${fmtStamp(a.time)} — ${a.note}`);
  } else {
    lines.push('No gaps, volume spikes or pivots flagged.');
  }
  lines.push('');
  lines.push('## Timeline');
  if (timeline.length) {
    for (const ev of timeline) {
      const leg = isNum(ev.legPct)
        ? ` (→ ${ev.legPct >= 0 ? '+' : ''}${ev.legPct.toFixed(1)}% over ${ev.legBars} bars)`
        : '';
      lines.push(`- ${fmtStamp(ev.time)} — ${ev.note}${leg}`);
    }
  } else {
    lines.push('The window has no narratable structure.');
  }
  lines.push('');
  lines.push('---');
  lines.push('_Computed locally by wickchart-briefing · nothing left the page_');

  return {
    title,
    generatedAt,
    window: { from: summary.from, to: summary.to, bars: summary.bars, timeframe: summary.timeframe },
    summary,
    signals,
    annotations,
    timeline,
    markdown: lines.join('\n'),
  };
}
