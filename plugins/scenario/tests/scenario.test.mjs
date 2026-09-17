// wickchart-scenario — the pure surface: cone math and spec validation.
// Mirrors the pr24/pr25 contracts the core copies carry (the functions are
// re-exported from wickchart/core during the additive window; at the 2.0
// cut they settle here — ROADMAP-V2.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { calcVolCone, normalizeScenario, normalizeRiskPlan } from '../core.mjs';
// the core copy this package wraps until 2.0 — must stay the same function
const wccore = await import('wickchart/core');

const read = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');

/* ------------------------- calcVolCone ------------------------- */

test('cone anchors at bar 0 and widens monotonically with √h', () => {
  const c = calcVolCone(100, 0.02, 10, [1, 2]);
  assert.equal(c.horizon, 10);
  assert.deepEqual(c.levels, [1, 2]);
  for (const z of c.levels) {
    const b = c.bands[z];
    assert.equal(b.up[0], 100, `z=${z} anchors at the last close`);
    assert.equal(b.down[0], 100);
    for (let h = 1; h <= 10; h++) {
      assert.ok(b.up[h] > b.up[h - 1], `up widens at h=${h}`);
      assert.ok(b.down[h] < b.down[h - 1], `down widens at h=${h}`);
    }
  }
  assert.ok(c.bands[2].up[10] > c.bands[1].up[10]);
  assert.ok(c.bands[2].down[10] < c.bands[1].down[10]);
});

test('cone scales with √h (GBM): band at h=4 is the square of the band at h=1', () => {
  const c = calcVolCone(100, 0.02, 4, [1]);
  const k1 = c.bands[1].up[1] / 100;
  const k4 = c.bands[1].up[4] / 100;
  assert.ok(Math.abs(k4 - k1 * k1) < 1e-9, `k4=${k4} ≈ k1²=${k1 * k1}`);
});

test('cone handles degenerate input: zero vol → flat, invalid → clamped', () => {
  const flat = calcVolCone(100, 0, 5, [1]);
  assert.ok(flat.bands[1].up.every((v) => v === 100), 'zero vol is a flat band');
  const bad = calcVolCone(100, NaN, 5, [1]);
  assert.ok(bad.bands[1].up.every((v) => v === 100), 'NaN vol degrades to flat');
  const clampedZ = calcVolCone(100, 0.02, 5, [9, 0, -1, 1.5]);
  assert.deepEqual(clampedZ.levels, [1.5], 'levels clamp to (0, 5]');
  assert.equal(calcVolCone(100, 0.02, 9999).horizon, 500, 'horizon clamps to 500');
  assert.equal(calcVolCone(100, 0.02).horizon, 48, 'default horizon 48');
  assert.deepEqual(calcVolCone(100, 0.02, 5).levels, [1, 2], 'default levels [1,2]');
});

/* ------------------------- normalizeScenario ------------------------- */

test('normalizeScenario accepts plain prices and {price} objects, dropping junk', () => {
  const s = normalizeScenario({ path: [100, { price: 110 }, 'junk', -5, { price: 120 }] });
  assert.deepEqual(s.path, [
    { h: 1, price: 100 },
    { h: 2, price: 110 },
    { h: 3, price: 120 },
  ]);
  assert.equal(s.horizon, 3, 'horizon defaults to the path length');
});

test('normalizeScenario defaults: cone on, levels [1,2], color/label sanitized', () => {
  const s = normalizeScenario({ horizon: 48 });
  assert.equal(s.cone, true);
  assert.deepEqual(s.levels, [1, 2]);
  assert.equal(s.color, null);
  assert.equal(s.label, '');
  assert.equal(s.path.length, 0, 'cone-only scenario (no path) is valid');

  const t = normalizeScenario({ horizon: 24, color: 'javascript:alert(1)', label: 'x'.repeat(60), levels: [2, 0.5] });
  assert.equal(t.color, null, 'unsafe colors are dropped (accent at draw time)');
  assert.equal(t.label.length, 40);
  assert.deepEqual(t.levels, [0.5, 2], 'levels sorted ascending');
  assert.equal(normalizeScenario({ horizon: 10, cone: false, color: 'up' }).color, 'up', 'palette keys survive');
});

test('normalizeScenario caps and rejects: 250-point path, no path+no horizon → null', () => {
  const big = normalizeScenario({ path: Array.from({ length: 400 }, (_, i) => 100 + i) });
  assert.equal(big.path.length, 250);
  assert.equal(big.horizon, 250);
  assert.equal(normalizeScenario(null), null);
  assert.equal(normalizeScenario('bull'), null);
  assert.equal(normalizeScenario({ path: [] }), null, 'empty path and no horizon is invalid');
  assert.equal(normalizeScenario({ path: [-1, 0] }), null, 'all-invalid path is invalid');
});

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

/* ------------------------- the 1.x seam ------------------------- */

test('during 1.x the pure surface is the very same function core ships', () => {
  assert.equal(normalizeScenario, wccore.normalizeScenario);
  assert.equal(normalizeRiskPlan, wccore.normalizeRiskPlan);
  assert.equal(calcVolCone, wccore.calcVolCone);
});

test('core.mjs is the documented re-export seam, not a drifted copy', () => {
  const src = read('plugins/scenario/core.mjs');
  assert.match(src, /from 'wickchart\/core'/, 're-exports from the shared core');
  assert.match(src, /wickchart-narrator/, 'the sharing story (narrator imports the same normalizers) is documented');
});
