// PR #25 — risk planner: R-multiple grid anchored at entry/stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const { normalizeRiskPlan } = await import('../src/core.js');

/* ------------------------- normalizeRiskPlan ------------------------- */

test('long plan: stop below entry, 1R = |entry − stop|, levels at entry + kR', () => {
  const p = normalizeRiskPlan({ entry: 64500, stop: 63800 });
  assert.equal(p.direction, 'long');
  assert.equal(p.risk, 700);
  assert.deepEqual(p.levels, [
    { k: 1, price: 65200 },
    { k: 2, price: 65900 },
    { k: 3, price: 66600 },
  ]);
  assert.equal(p.maxK, 3);
});

test('short plan: stop above entry, levels extend below', () => {
  const p = normalizeRiskPlan({ entry: 100, stop: 102, multiples: [1, 2] });
  assert.equal(p.direction, 'short');
  assert.equal(p.risk, 2);
  assert.deepEqual(p.levels, [
    { k: 1, price: 98 },
    { k: 2, price: 96 },
  ]);
});

test('explicit targets convert to their R multiple; wrong-side prices drop', () => {
  const p = normalizeRiskPlan({ entry: 100, stop: 98, targets: [104, 90, 103, 'junk', -5] });
  // 104 → 2R, 103 → 1.5R kept; 90 is below entry (negative R) → dropped
  assert.deepEqual(p.levels, [
    { k: 1.5, price: 103 },
    { k: 2, price: 104 },
  ]);
  assert.equal(p.maxK, 2);
});

test('multiples win over targets; validated, deduped, sorted, capped', () => {
  const both = normalizeRiskPlan({
    entry: 100, stop: 99,
    multiples: [2, 1, 2, 0, -3, 25, 1.5],
    targets: [150],
  });
  assert.deepEqual(both.levels.map((l) => l.k), [1, 1.5, 2], 'targets ignored when multiples given');
  const capped = normalizeRiskPlan({
    entry: 100, stop: 99,
    multiples: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  });
  assert.equal(capped.levels.length, 8, 'at most 8 levels');
  const allBad = normalizeRiskPlan({ entry: 100, stop: 99, multiples: [0, -1, 99] });
  assert.deepEqual(allBad.levels.map((l) => l.k), [1, 2, 3], 'fully-invalid multiples fall back to [1,2,3]');
});

test('invalid plans → null; label caps at 40; defaults documented', () => {
  assert.equal(normalizeRiskPlan(null), null);
  assert.equal(normalizeRiskPlan('long'), null);
  assert.equal(normalizeRiskPlan({}), null);
  assert.equal(normalizeRiskPlan({ entry: 100 }), null);
  assert.equal(normalizeRiskPlan({ entry: 100, stop: 100 }), null, 'entry === stop is degenerate');
  assert.equal(normalizeRiskPlan({ entry: -100, stop: -110 }), null, 'non-positive prices rejected');
  assert.equal(normalizeRiskPlan({ entry: NaN, stop: 1 }), null);
  const p = normalizeRiskPlan({ entry: 100, stop: 99, label: 'x'.repeat(60) });
  assert.equal(p.label.length, 40);
  assert.equal(normalizeRiskPlan({ entry: 100, stop: 99 }).label, '');
});

/* ------------------------- component contract ------------------------- */

test('component exposes the risk plan API and draws from the core math', () => {
  const src = read('src/wick-chart.js');
  assert.match(src, /setRiskPlan\(spec\)/);
  assert.match(src, /clearRiskPlan\(\)/);
  assert.match(src, /get riskPlan\(\)/);
  assert.match(src, /normalizeRiskPlan\(spec\)/, 'specs validated through core');
  const block = src.slice(src.indexOf('risk plan: R-multiple grid'), src.indexOf('volume profile (behind the series)'));
  assert.ok(block.length > 400, 'draw block present');
  assert.match(block, /pal\.down/, 'risk zone uses the down palette color');
  assert.match(block, /pal\.up/, 'reward lines use the up palette color');
  assert.match(block, /pal\.accent/, 'entry line uses the accent color');
  assert.match(block, /this\._pill\(/, 'levels labeled with pills');
  assert.match(block, /lastY \+ 20/, 'pills de-collide instead of overlapping');
});

test('risk plan stays out of getState — it is app state, not chart state', () => {
  const src = read('src/wick-chart.js');
  assert.doesNotMatch(src, /riskPlan\s*:/, 'no riskPlan key in serialized state');
});

test('the plugins hub covers the risk planner API and semantics', () => {
  const hub = read('plugins.html');
  const sec = hub.slice(hub.indexOf('id="scenario"'), hub.indexOf('id="ai"'));
  assert.ok(sec.length > 1500, 'risk planner coverage is substantive');
  for (const s of ['setRiskPlan', 'clearRiskPlan', 'riskPlan', 'multiples', 'targets', 'entry', 'stop', 'direction']) {
    assert.ok(sec.includes(s), `"${s}" missing from the hub scenario section`);
  }
  assert.ok(hub.includes('href="#scenario"'), 'hub TOC links the section');
  assert.ok(read('README.md').includes('getPeers()'), 'README mentions getPeers()');
});
