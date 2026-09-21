// Ichimoku: tenkan/kijun midpoints, forward-displaced senkou spans (the
// kumo, filled between A and B), and the back-displaced chikou line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calcIchimoku,
  BUILTIN_INDICATORS,
  parseIndicators,
  normalizeIndicatorResult,
} from '../src/core.js';

// A ramp: high = i+10, low = i, close = i+5 — every window midpoint has a
// closed form, so expected values are inline arithmetic.
const gen = (n) =>
  Array.from({ length: n }, (_, i) => ({ time: (i + 1) * 3600e3, open: i + 5, high: i + 10, low: i, close: i + 5, volume: 100 }));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* ---------------- the math ---------------- */

test('calcIchimoku: tenkan/kijun midpoints, displaced spans, chikou', () => {
  const bars = gen(12);
  const c = calcIchimoku(bars, 3, 4, 5, 2);

  // senkou spans run `disp` past the last bar; everything else stays n-long
  assert.equal(c.tenkan.length, 12);
  assert.equal(c.kijun.length, 12);
  assert.equal(c.chikou.length, 12);
  assert.equal(c.senkouA.length, 14);
  assert.equal(c.senkouB.length, 14);

  // tenkan(3): (max high + min low) / 2 over [i-2, i] = (i+10 + i-2)/2
  assert.equal(c.tenkan[0], null);
  assert.equal(c.tenkan[1], null);
  assert.ok(near(c.tenkan[2], 6)); // (12 + 0) / 2
  assert.ok(near(c.tenkan[11], 15)); // (21 + 9) / 2

  // kijun(4): window [i-3, i] = (i+10 + i-3)/2
  assert.equal(c.kijun[2], null);
  assert.ok(near(c.kijun[3], 6.5)); // (13 + 0) / 2
  assert.ok(near(c.kijun[11], 14.5)); // (21 + 8) / 2

  // senkouA lands disp bars ahead: A[i+2] = (tenkan[i] + kijun[i]) / 2, i >= 3
  assert.equal(c.senkouA[4], null);
  assert.ok(near(c.senkouA[5], 6.75)); // (tenkan[3] + kijun[3]) / 2 = (7 + 6.5) / 2
  assert.ok(near(c.senkouA[13], 14.75)); // (15 + 14.5) / 2 at i = 11
  for (let j = 5; j < 14; j++) {
    assert.ok(near(c.senkouA[j], (c.tenkan[j - 2] + c.kijun[j - 2]) / 2), 'A at ' + j);
  }

  // senkouB(5): window [i-4, i] = (i+10 + i-4)/2, also displaced
  assert.equal(c.senkouB[5], null);
  assert.ok(near(c.senkouB[6], 7)); // (14 + 0) / 2 at i = 4
  assert.ok(near(c.senkouB[13], 14)); // (21 + 7) / 2 at i = 11

  // chikou: close shifted disp bars back — null in the last disp slots
  assert.ok(near(c.chikou[0], 7)); // close[2]
  assert.ok(near(c.chikou[9], 16)); // close[11]
  assert.equal(c.chikou[10], null);
  assert.equal(c.chikou[11], null);
});

test('calcIchimoku: default 9/26/52/26 warm-up boundaries', () => {
  const bars = gen(60);
  const c = calcIchimoku(bars);
  assert.equal(c.senkouA.length, 86); // 60 + 26
  assert.equal(typeof c.tenkan[8], 'number'); // first full tenkan window
  assert.equal(c.tenkan[7], null);
  assert.equal(typeof c.kijun[25], 'number'); // first full kijun window
  assert.equal(c.kijun[24], null);
  assert.equal(typeof c.senkouA[51], 'number'); // kijun[25] + 26
  assert.equal(c.senkouA[50], null);
  assert.equal(typeof c.senkouB[77], 'number'); // first full 52-bar window (i=51) + 26
  assert.equal(c.senkouB[76], null);
  assert.equal(c.chikou[34], null); // close[60] doesn't exist
  assert.ok(near(c.chikou[33], 64)); // close[59] = 59 + 5
});

/* ---------------- registry & result shape ---------------- */

test('BUILTIN_INDICATORS: ichimoku overlay with kumo fill', () => {
  const def = BUILTIN_INDICATORS.get('ichimoku');
  assert.ok(def);
  assert.equal(def.kind, 'overlay');
  assert.deepEqual(def.params, { tenkan: 9, kijun: 26, senkouB: 52, disp: 26 });
  const bars = gen(12);
  const res = normalizeIndicatorResult(def.compute(bars, { tenkan: 3, kijun: 4, senkouB: 5, disp: 2 }));
  const c = calcIchimoku(bars, 3, 4, 5, 2);
  assert.deepEqual(res.lines.map((l) => l.name), ['tenkan', 'kijun', 'senkouA', 'senkouB', 'chikou']);
  assert.deepEqual(res.lines[0].values, c.tenkan);
  assert.deepEqual(res.lines[4].values, c.chikou);
  assert.deepEqual(res.fill.a, c.senkouA); // the kumo is drawn between A and B
  assert.deepEqual(res.fill.b, c.senkouB);
});

test('normalizeIndicatorResult: fill passes through only when well-formed', () => {
  const a = [1, 2];
  const b = [3, 4];
  assert.deepEqual(normalizeIndicatorResult({ lines: [], fill: { a, b } }).fill, { a, b });
  assert.equal(normalizeIndicatorResult({ lines: [], fill: { a } }).fill, null);
  assert.equal(normalizeIndicatorResult({ lines: [] }).fill, null);
  assert.equal(normalizeIndicatorResult(null).fill, null);
  assert.equal(normalizeIndicatorResult(a).fill, null);
});

/* ---------------- parsing & docs ---------------- */

test('parseIndicators: ichimoku token, positional params, dedupe', () => {
  const r = parseIndicators('ichimoku:7/22/44/22', BUILTIN_INDICATORS);
  assert.equal(r.overlays.length, 1);
  assert.deepEqual(r.overlays[0].params, { tenkan: 7, kijun: 22, senkouB: 44, disp: 22 });
  const d = parseIndicators('ichimoku', BUILTIN_INDICATORS);
  assert.deepEqual(d.overlays[0].params, { tenkan: 9, kijun: 26, senkouB: 52, disp: 26 });
  // dedupe keys on the raw token (name:params), as with the other builtins
  const dup = parseIndicators('ichimoku:9/26/52/26 ichimoku:9/26/52/26', BUILTIN_INDICATORS);
  assert.equal(dup.overlays.length, 1);
});

test('docs and README list ichimoku', () => {
  const docs = readFileSync('docs.html', 'utf8');
  const readme = readFileSync('README.md', 'utf8');
  assert.ok(docs.includes('<code>ichimoku</code>'), 'docs.html missing ichimoku');
  assert.ok(readme.includes('`ichimoku`'), 'README missing ichimoku');
});
