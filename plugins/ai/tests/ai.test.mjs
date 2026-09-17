// wickchart-ai — the pure agent surface: tool manifest, system prompt and
// the validated dispatcher. Mirrors the pr23 contract the core copy
// carries (the functions are re-exported from wickchart/core during the
// additive window; at the 2.0 cut they settle here — ROADMAP-V2.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { AI_TOOLS, aiPromptText, applyChartOps } from '../core.mjs';
const wccore = await import('wickchart/core');
const { normalizeOverlays } = wccore;

const read = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');

/* ------------------------- manifest ------------------------- */

test('AI_TOOLS manifest is complete and self-describing', () => {
  const names = AI_TOOLS.map((t) => t.tool);
  assert.ok(names.length >= 9, `expected a full tool set, got ${names.length}`);
  assert.equal(new Set(names).size, names.length, 'tool names unique');
  for (const t of AI_TOOLS) {
    assert.equal(typeof t.tool, 'string');
    assert.ok(t.description && t.description.length > 10, `${t.tool} has a real description`);
    assert.equal(typeof t.args, 'object');
  }
  for (const need of ['get_data_window', 'set_indicators', 'set_overlays', 'add_alert', 'set_view', 'set_type']) {
    assert.ok(names.includes(need), `tool ${need} present`);
  }
});

test('aiPromptText lists every tool and demands JSON ops', () => {
  const p = aiPromptText();
  for (const t of AI_TOOLS) assert.ok(p.includes(t.tool), `prompt mentions ${t.tool}`);
  assert.ok(p.includes('JSON array'), 'prompt asks for a JSON array of ops');
  assert.ok(p.includes('WickChart'), 'prompt identifies the element');
});

/* ------------------------- dispatcher ------------------------- */

function makeTarget() {
  const calls = [];
  const target = {
    calls,
    getDataWindow() { calls.push(['getDataWindow']); return { text: 'SUMMARY', trend: { label: 'up' } }; },
    setAttribute(k, v) { calls.push(['setAttribute', k, v]); },
    setOverlays(list) { calls.push(['setOverlays', list]); return normalizeOverlays(list).map((o) => o.id); },
    clearOverlays() { calls.push(['clearOverlays']); },
    addAlert(a) { calls.push(['addAlert', a]); return a.when === 'bad(' ? null : 'a1'; },
    setVisibleRange(r) { calls.push(['setVisibleRange', r]); },
    fit() { calls.push(['fit']); },
  };
  target.constructor = { _registry: () => new Map([['sma', {}], ['rsi', {}], ['volume', {}]]) };
  return target;
}

test('get_data_window passes the summary through', () => {
  const t = makeTarget();
  const [r] = applyChartOps(t, [{ tool: 'get_data_window', args: {} }]);
  assert.equal(r.ok, true);
  assert.equal(r.result.text, 'SUMMARY');
  assert.deepEqual(t.calls[0], ['getDataWindow']);
});

test('set_indicators validates against the registry before applying', () => {
  const t = makeTarget();
  const [ok] = applyChartOps(t, [{ tool: 'set_indicators', args: { indicators: 'sma:20 rsi:14 volume' } }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(t.calls[0], ['setAttribute', 'indicators', 'sma:20 rsi:14 volume']);

  const t2 = makeTarget();
  const [bad] = applyChartOps(t2, [{ tool: 'set_indicators', args: { indicators: 'sma:20 nosuch:3' } }]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /nosuch/, 'error names the unknown indicator');
  assert.equal(t2.calls.length, 0, 'nothing applied when a name is unknown');
});

test('set_overlays reports applied/dropped and rejects all-invalid lists', () => {
  const t = makeTarget();
  const [r] = applyChartOps(t, [{
    tool: 'set_overlays',
    args: { overlays: [
      { type: 'level', price: 100 },
      { type: 'zone', priceFrom: 1 }, // invalid — dropped
    ] },
  }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { applied: 1, dropped: 1 });

  const t2 = makeTarget();
  const [bad] = applyChartOps(t2, [{ tool: 'set_overlays', args: { overlays: [{ type: 'zone', priceFrom: 1 }] } }]);
  assert.equal(bad.ok, false);
  assert.equal(t2.calls.length, 0);
});

test('add_alert accepts price and when forms, rejects neither/nonsense', () => {
  const t = makeTarget();
  const [p] = applyChartOps(t, [{ tool: 'add_alert', args: { price: 123, direction: 'above' } }]);
  assert.equal(p.ok, true);
  const [w] = applyChartOps(t, [{ tool: 'add_alert', args: { when: 'close > sma(close,20)' } }]);
  assert.equal(w.ok, true);
  const [n] = applyChartOps(t, [{ tool: 'add_alert', args: {} }]);
  assert.equal(n.ok, false);
  assert.match(n.error, /price.*when|when.*price/);
  const [b] = applyChartOps(t, [{ tool: 'add_alert', args: { when: 'bad(' } }]);
  assert.equal(b.ok, false, 'predicate rejected by the target surfaces as an error');
});

test('set_view converts unix seconds to ms', () => {
  const t = makeTarget();
  const [r] = applyChartOps(t, [{ tool: 'set_view', args: { from: 1700000000, to: 1700086400000 } }]);
  assert.equal(r.ok, true);
  const range = t.calls[0][1];
  assert.equal(range.from, 1700000000000);
  assert.equal(range.to, 1700086400000);
  const [none] = applyChartOps(t, [{ tool: 'set_view', args: {} }]);
  assert.equal(none.ok, false);
});

test('set_type and set_volshading validate their enums', () => {
  const t = makeTarget();
  const [ok] = applyChartOps(t, [{ tool: 'set_type', args: { type: 'heikin' } }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(t.calls[0], ['setAttribute', 'type', 'heikin']);
  const [bad] = applyChartOps(t, [{ tool: 'set_type', args: { type: 'pie' } }]);
  assert.equal(bad.ok, false);

  const t2 = makeTarget();
  applyChartOps(t2, [{ tool: 'set_volshading', args: { enabled: true, low: 20, high: 85 } }]);
  assert.deepEqual(t2.calls[0], ['setAttribute', 'volshading', '20/85']);
  applyChartOps(t2, [{ tool: 'set_volshading', args: { enabled: false } }]);
  assert.deepEqual(t2.calls[1], ['setAttribute', 'volshading', 'false']);
});

test('malformed ops and unknown tools produce errors, never throws', () => {
  const t = makeTarget();
  assert.equal(applyChartOps(t, null)[0].ok, false);
  assert.equal(applyChartOps(t, 'nope')[0].ok, false);
  assert.equal(applyChartOps(t, [42])[0].ok, false);
  assert.equal(applyChartOps(t, [{ tool: 'rm_rf', args: {} }])[0].ok, false);
  assert.match(applyChartOps(t, [{ tool: 'rm_rf', args: {} }])[0].error, /unknown tool/);
  // a target method that throws is caught per-op
  const t2 = makeTarget();
  t2.fit = () => { throw new Error('boom'); };
  const [r] = applyChartOps(t2, [{ tool: 'reset_view', args: {} }]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'boom');
});

test('multi-op batches return per-op results in order', () => {
  const t = makeTarget();
  const rs = applyChartOps(t, [
    { tool: 'set_type', args: { type: 'line' } },
    { tool: 'set_indicators', args: { indicators: 'nope' } },
    { tool: 'clear_overlays', args: {} },
  ]);
  assert.deepEqual(rs.map((r) => r.ok), [true, false, true]);
});

/* ------------------------- the 1.x seam ------------------------- */

test('the agent surface is owned here — it left the core entry at the cut', () => {
  assert.equal(wccore.AI_TOOLS, undefined);
  assert.equal(wccore.aiPromptText, undefined);
  assert.equal(wccore.applyChartOps, undefined);
  assert.equal(typeof AI_TOOLS !== 'undefined' && AI_TOOLS.length >= 9, true, 'the manifest lives in this package');
});

test('core.mjs is the documented re-export seam, not a drifted copy', () => {
  const src = read('plugins/ai/core.mjs');
  assert.match(src, /from 'wickchart\/core'/, 're-exports from the shared core');
  assert.match(src, /untrusted input/, 'the validation contract is documented');
});
