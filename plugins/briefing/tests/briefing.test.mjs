// wickchart-briefing — pure coverage: the composed model over a synthetic
// tape with known structure (a run-up, a spike, a gap, pivots), the signal
// census, the markdown shape and determinism, plus the attach/detach
// contract on a duck-typed chart. The clipboard half is browser-only.
import test from 'node:test';
import assert from 'node:assert/strict';

const { briefingModel, signalCensus, fmtStamp } = await import('../core.mjs');
const { attachBriefing } = await import('../briefing.mjs');
const { detectSignals } = await import('wickchart-signals/core');
const { narrateWindow } = await import('wickchart-narrator/core');
const { windowSummary } = await import('wickchart/core');

/* A tape with guaranteed structure: an overnight gap, a 4× volume spike,
 * a pivot low then a strong run-up into a pivot high, and seeded-varied
 * candle anatomy so the pattern detectors have real work (opens at the
 * previous close, wicks of varying proportion). */
const T0 = Date.UTC(2026, 8, 20, 0, 0);
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const bars = [];
let prevClose = 100;
for (let i = 0; i < 300; i++) {
  const phase = i < 80 ? 0.02 : i < 140 ? -0.15 : 0.35; // drift → dip → run
  const open = prevClose;
  const close = Math.max(1, open * (1 + phase / 100 + (rnd() - 0.5) / 80));
  const high = Math.max(open, close) * (1 + rnd() * 0.012);
  const low = Math.min(open, close) * (1 - rnd() * 0.012);
  // gap after bar 150 (skip an hour), spike on bar 200
  let t = T0 + i * 3600e3;
  if (i > 150) t += 3600e3;
  bars.push({
    time: t,
    open, high, low, close,
    volume: i === 200 ? 40000 : 400 + (i % 13) * 7,
  });
  prevClose = close;
}
const i0 = 0;
const i1 = bars.length - 1;
const NOW = Date.UTC(2026, 9, 7, 12, 0);

const model = () => briefingModel(bars, i0, i1, { label: 'SYN · 1h', dtMs: 3600e3, now: NOW });

/* ------------------------------ the model ------------------------------ */

test('the briefing composes every section over the window', () => {
  const m = model();
  assert.ok(m, 'the window is valid');
  assert.equal(m.title, 'SYN · 1h — chart briefing');
  assert.equal(m.generatedAt, NOW);
  assert.equal(m.window.bars, 300);
  assert.equal(m.window.timeframe, '1h');
  assert.ok(m.summary === windowSummary(bars, i0, i1, { dtMs: 3600e3, label: 'SYN · 1h' }) ||
    JSON.stringify(m.summary) === JSON.stringify(windowSummary(bars, i0, i1, { dtMs: 3600e3, label: 'SYN · 1h' })),
  'the tape section IS windowSummary, not a re-derivation');
  assert.ok(m.signals.total > 0, 'the synthetic tape has candle signals');
  assert.equal(m.signals.total, detectSignals(bars).filter((s) => s.i >= i0 && s.i <= i1).length);
  assert.ok(m.annotations.length > 0, 'the spike/gap/pivots get flagged');
  assert.deepEqual(
    m.timeline.map((e) => e.i),
    narrateWindow(bars, i0, i1).map((e) => e.i),
    'the timeline IS narrateWindow, not a re-derivation');
  assert.ok(m.timeline.some((e) => Number.isFinite(e.legPct)), 'legs are carried');
});

test('the markdown is a complete, deterministic document', () => {
  const md = model().markdown;
  for (const heading of ['# SYN · 1h — chart briefing', '## Tape', '## Signals', '## Annotations', '## Timeline']) {
    assert.ok(md.includes(heading), `missing ${heading}`);
  }
  assert.ok(md.includes('_2026-09-20 00:00 →'), 'window dates are UTC-stable');
  assert.ok(md.includes('· generated 2026-10-07 12:00_'), 'generated stamp is the injected clock');
  assert.ok(!md.includes('CHART SUMMARY'), "windowSummary's header line does not duplicate the briefing header");
  assert.ok(md.includes('wickchart-briefing'));
  // determinism: same inputs (+ clock) → byte-identical document
  assert.equal(model().markdown, md);
});

test('windows smaller than the detectors need are handled, not crashed', () => {
  const tiny = briefingModel(bars.slice(0, 3), 0, 2, { now: NOW });
  assert.ok(tiny, 'a 3-bar window still briefs');
  assert.ok(tiny.markdown.includes('## Timeline'));
  assert.equal(briefingModel(bars.slice(0, 1), 0, 0, { now: NOW }), null, 'a 1-bar window returns null');
  assert.equal(briefingModel([], 0, 0, { now: NOW }), null);
});

test('fmtStamp is UTC-stable and the census groups by direction and kind', () => {
  assert.equal(fmtStamp(Date.UTC(2026, 9, 7, 9, 5)), '2026-10-07 09:05');
  const c = signalCensus(bars, i0, i1);
  assert.equal(c.total, Object.values(c.counts).reduce((a, b) => a + b, 0));
  for (const name of Object.keys(c.counts)) {
    assert.match(name, /^(bullish|bearish|neutral) (engulfing|pin bar|inside bar)$/);
  }
  assert.ok(c.latest.length <= 3);
  // a kind subset narrows the census
  const only = signalCensus(bars, i0, i1, ['inside']);
  assert.ok(only.total <= c.total);
  assert.ok(Object.keys(only.counts).every((k) => k.includes('inside')));
});

/* ------------------------------- attach ------------------------------- */

/** Duck chart: only the public surfaces attachBriefing reads. */
function makeChart(win) {
  return {
    data: bars,
    getVisibleRange: () => win,
    getAttribute: () => 'SYN · 1h',
  };
}

test('attachBriefing installs chart.briefing() over the visible range', () => {
  const chart = makeChart({ from: bars[10].time, to: bars[110].time });
  const handle = attachBriefing(chart);
  const m = chart.briefing();
  assert.ok(m);
  assert.equal(m.window.from, bars[10].time);
  assert.equal(m.window.to, bars[110].time);
  assert.equal(m.window.bars, 101);
  assert.notEqual(m.markdown, model().markdown, 'a narrower window briefs differently');

  // no data / no range degrade honestly
  const empty = { data: [], getVisibleRange: () => null, getAttribute: () => 'x' };
  attachBriefing(empty);
  assert.equal(empty.briefing(), null);
});

test('detach restores the instance, and copyBriefing fails loudly off-browser', async () => {
  const chart = makeChart({ from: bars[0].time, to: bars[99].time });
  const before = 'still mine';
  chart.briefing = before;
  const handle = attachBriefing(chart);
  assert.notEqual(chart.briefing, before);
  await assert.rejects(() => chart.copyBriefing(), /clipboard/);
  handle.detach();
  assert.equal(chart.briefing, before, 'a pre-existing own property is restored');
  assert.equal('copyBriefing' in chart, false, 'an installed property is removed');
});
