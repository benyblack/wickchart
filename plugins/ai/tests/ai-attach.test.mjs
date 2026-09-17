// wickchart-ai — the attach layer: the five agent methods installed on
// the instance, payload building, ask()/run round-trips and detach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { attachAI } from '../ai.mjs';
import { AI_TOOLS, applyChartOps } from '../core.mjs';
const { WickChart } = await import('../../../src/wick-chart.js');

const read = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');

/** Duck chart: the state/data-window surface plus the op surface the
 *  dispatcher drives (exactly the element's public methods). */
function agentChart() {
  const attrs = {};
  const c = {
    attrs,
    getDataWindow() { return { text: 'SUMMARY: up 12%, vol warm', trend: { label: 'up' } }; },
    getState() { return { type: 'candles', indicators: 'sma:20' }; },
    setAttribute(k, v) { attrs[k] = String(v); },
    setOverlays(list) { return list.map((o, i) => o.id || 'ov' + i); },
    clearOverlays() {},
    addAlert() { return 'a1'; },
    setVisibleRange() {},
    fit() {},
    dispatchEvent() { return true; },
  };
  c.constructor = { _registry: () => new Map([['sma', {}], ['rsi', {}], ['volume', {}]]) };
  return c;
}

/* ------------------------- attach / validation ------------------------- */

test('attachAI validates the surface, installs the five methods, is idempotent', () => {
  assert.throws(() => attachAI(null), TypeError);
  assert.throws(() => attachAI({ getState() {} }), TypeError, 'no data window / event surface');
  const c = agentChart();
  const a = attachAI(c);
  assert.equal(attachAI(c), a, 'second attach returns the same controller');
  for (const m of ['aiTools', 'aiPrompt', 'aiContext', 'applyAI', 'ask']) {
    assert.ok(c.hasOwnProperty(m), `${m} installed as an own property`);
  }
});

test('additive phase: the core element still carries its own agent methods', () => {
  for (const m of ['aiTools', 'aiPrompt', 'aiContext', 'applyAI', 'ask']) {
    assert.equal(typeof WickChart.prototype[m], 'function', `core prototype still has ${m}`);
  }
});

/* ------------------------- the methods ------------------------- */

test('aiTools hands out JSON-safe copies; aiPrompt matches the manifest', () => {
  const c = agentChart();
  attachAI(c);
  const t1 = c.aiTools();
  const t2 = c.aiTools();
  assert.deepEqual(t1, AI_TOOLS);
  assert.notEqual(t1, AI_TOOLS, 'a copy, not the live manifest');
  t1.pop();
  assert.equal(c.aiTools().length, AI_TOOLS.length, 'mutating a copy leaves the manifest intact');
  assert.ok(c.aiPrompt().includes('WickChart'));
});

test('aiContext composes the core state + data window (getDataWindow stays core)', () => {
  const c = agentChart();
  attachAI(c);
  const ctx = c.aiContext();
  assert.equal(ctx.state.type, 'candles');
  assert.equal(ctx.window.text, 'SUMMARY: up 12%, vol warm');
  const src = read('plugins/ai/ai.mjs');
  assert.match(src, /c\.getDataWindow\(\)/, 'composed through the public data API');
  assert.ok(!src.includes('windowSummary'), 'no private re-implementation of the window summary');
});

test('applyAI routes through the validated dispatcher on the real target', () => {
  const c = agentChart();
  attachAI(c);
  const rs = c.applyAI([
    { tool: 'set_type', args: { type: 'line' } },
    { tool: 'set_indicators', args: { indicators: 'sma:20 nosuch:3' } },
  ]);
  assert.deepEqual(rs.map((r) => r.ok), [true, false]);
  assert.equal(c.attrs.type, 'line');
  assert.equal(c.attrs.indicators, undefined, 'the invalid batch op applied nothing');
});

test('ask() without run returns the payload for manual wiring', async () => {
  const c = agentChart();
  attachAI(c);
  const { payload, ops, results } = await c.ask('add RSI and mark the demand zone');
  assert.equal(ops, null);
  assert.equal(results, null);
  assert.ok(payload.system.includes('WickChart'));
  assert.equal(payload.instruction, 'add RSI and mark the demand zone');
  assert.ok(Array.isArray(payload.tools) && payload.tools.length === AI_TOOLS.length);
  assert.equal(payload.chart.state.type, 'candles');
  assert.equal(payload.chart.window.text, 'SUMMARY: up 12%, vol warm');
  // instructions are stringified defensively
  const weird = await c.ask(null);
  assert.equal(weird.payload.instruction, '');
});

test('ask() with run applies the returned ops and resolves their results', async () => {
  const c = agentChart();
  attachAI(c);
  let seen = null;
  const { payload, ops, results } = await c.ask('switch to a line chart', {
    run: async (p) => {
      seen = p;
      return [{ tool: 'set_type', args: { type: 'line' } }, { tool: 'set_view', args: { from: 1700000000, to: 1700086400 } }];
    },
  });
  assert.equal(seen, payload, 'run receives the very payload object');
  assert.equal(ops.length, 2);
  assert.deepEqual(results.map((r) => r.ok), [true, true]);
  assert.equal(c.attrs.type, 'line');
  // a run that returns garbage degrades to per-op errors, never throws
  const bad = await c.ask('do things', { run: async () => 'nonsense' });
  assert.equal(bad.results.length, 1);
  assert.equal(bad.results[0].ok, false);
});

/* ------------------------- detach ------------------------- */

test('detach restores the element methods; a detached controller degrades safely', async () => {
  const c = agentChart();
  const a = attachAI(c);
  a.detach();
  for (const m of ['aiTools', 'aiPrompt', 'aiContext', 'applyAI', 'ask']) {
    assert.ok(!c.hasOwnProperty(m), `${m} removed`);
  }
  assert.equal(a.applyAI([{ tool: 'set_type', args: { type: 'line' } }])[0].ok, false, 'detached applyAI reports failure');
  const r = await a.ask('anything');
  assert.equal(r.ops, null, 'detached ask still builds a payload');
  assert.deepEqual(r.payload.chart, { state: null, window: null }, '…but grounds on nothing');
});

/* ------------------------- component contract ------------------------- */

test('the plugin composes core surfaces instead of re-implementing them', () => {
  const src = read('plugins/ai/ai.mjs');
  assert.match(src, /applyChartOps\(c, ops\)/, 'applyAI routes through the validated dispatcher');
  assert.match(src, /aiPromptText\(\)/, 'prompt from the shared builder');
  assert.ok(!src.includes('WickChart.prototype'), 'the prototype is never touched');
  assert.ok(!src.includes('fetch('), 'the plugin never touches the network');
  assert.ok(!/https?:\/\//.test(src), 'no endpoints either — run is yours');
});
