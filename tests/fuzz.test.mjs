// The property fuzz — adversarial tapes through every pure kernel. This is
// the Node half of the fuzz gate (the live-element half is
// e2e/fuzz.spec.mjs); it runs as part of `npm test` with a bounded
// iteration budget, and any failure prints its seed so it replays exactly:
//
//   WICK_FUZZ_SEED=123456789 npm test -- tests/fuzz.test.mjs
//   WICK_FUZZ_ITER=20000 npm test -- tests/fuzz.test.mjs   # a deeper dig
//
// The properties are contracts the suites already rely on, now checked over
// generated inputs instead of hand-picked ones: indicators never throw and
// always return bars.length-aligned number-or-null series; the stats,
// annotation, shape-search and summary kernels never throw; mergeOlderData
// keeps the tape sorted and deduplicated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { genBars, mulberry32 } from './fuzz-gen.mjs';

const {
  BUILTIN_INDICATORS, normalizeIndicatorResult, parseIndicators,
  computeStats, detectAnnotations, calcRSI, shapeSearch,
  mergeOlderData, buildColumns, windowSummary, compileScript,
} = await import('../src/core.js');

const ITER = Number(process.env.WICK_FUZZ_ITER || 400);
// WICK_FUZZ_SEED replays ONE seed's stream; unset, a fresh base seed drives
// ITER derived seeds (deterministic per run seed via --test worker args? no
// — derived from time, but each iteration's seed is printed on failure).
const REPLAY = Number(process.env.WICK_FUZZ_SEED || 0);
const BASE = REPLAY || (Date.now() ^ (process.pid << 8)) >>> 0;

const seedOf = (i) => (REPLAY ? BASE : (Math.imul(BASE ^ i, 0x85ebca6b) >>> 0));

/** One bar per timestamp — what the chart's own setData guarantees. */
const dedupByTime = (bars) => {
  const seen = new Set();
  return bars.filter((b) => (seen.has(b.time) ? false : (seen.add(b.time), true)));
};

/** The failure that names its seed — the replay contract. */
function fail(seed, i, what, err) {
  assert.fail(
    `${what} broke on iteration ${i} (bars seed ${seed}) — ${err && err.stack || err}\n` +
    `replay: WICK_FUZZ_SEED=${seed} npm test -- tests/fuzz.test.mjs`);
}

test(`every builtin indicator holds its contract over ${ITER} adversarial tapes`, () => {
  for (let i = 0; i < ITER; i++) {
    const seed = seedOf(i);
    const n = (mulberry32(seed ^ 0xabc)() * 400) | 0;
    const level = 1 + ((mulberry32(seed ^ 0xdef)() * 3) | 0); // 1..3
    const bars = genBars(seed, n, level);
    for (const [name, def] of BUILTIN_INDICATORS) {
      let res;
      try {
        res = normalizeIndicatorResult(def.compute(bars, def.params));
      } catch (err) {
        fail(seed, i, `indicator "${name}" (level ${level}, ${n} bars)`, err);
      }
      if (!Array.isArray(res.lines) || res.lines.length < 1) {
        fail(seed, i, `indicator "${name}" lines`, 'no lines array');
      }
      for (const ln of res.lines) {
        // ichimoku's senkou spans project 26 bars past the last bar (the
        // kumo needs future space) — every other series is tape-aligned
        const want = name === 'ichimoku' && /^senkou/.test(ln.name || '') ? n + 26 : n;
        if (!Array.isArray(ln.values) || ln.values.length !== want) {
          fail(seed, i, `indicator "${name}" line "${ln.name}"`, `values length ${ln.values && ln.values.length} ≠ ${want}`);
        }
        for (const v of ln.values) {
          if (!(v == null || typeof v === 'number')) {
            fail(seed, i, `indicator "${name}" line "${ln.name}"`, `non-numeric value ${typeof v}`);
          }
        }
      }
    }
  }
});

test(`the analysis kernels survive every adversarial tape`, () => {
  for (let i = 0; i < ITER; i++) {
    const seed = seedOf(i ^ 0x51ed);
    const n = (mulberry32(seed)() * 300) | 0;
    const level = 1 + ((mulberry32(seed ^ 1)() * 3) | 0);
    const bars = genBars(seed, n, level);
    const finite = bars.filter((b) => [b.open, b.high, b.low, b.close].every(Number.isFinite));
    const i0 = 0;
    const i1 = Math.max(0, bars.length - 1);
    try {
      if (bars.length > 1) {
        computeStats(bars, i0, i1, 3600e3);
        windowSummary(bars, i0, i1, { dtMs: 3600e3 });
        detectAnnotations(bars, i0, i1, calcRSI(bars.map((b) => b.close), 14));
        buildColumns(bars, 10, (b) => b.close);
      }
      // unknown-but-well-formed names collect into `unknown`; tokens that
      // don't even parse the name shape drop silently; garbage params
      // fall back to defaults — the attribute path never throws
      const parsed = parseIndicators(
        'sma:20 rsi:14 banana expr:{close - sma(close,20)} banana!!', BUILTIN_INDICATORS);
      assert.ok(parsed.unknown.includes('banana'), 'unknown names are collected, not thrown');
      assert.equal(parsed.overlays.filter((o) => o.name === 'banana').length, 0);
      // WickScript: valid sources compile; broken ones throw a catchable
      // error (the demo's script input catches exactly this)
      assert.ok(compileScript('close - sma(close,20)'));
      assert.throws(() => compileScript('close - sma(close,20) + garbage('));
      // shape search: never throws on hostile series, always answers an
      // array, and every match score is finite
      if (finite.length > 12) {
        const closes = finite.map((b) => b.close);
        for (const call of [
          () => shapeSearch(closes, 0, 12),
          () => shapeSearch(closes, 0, finite.length + 500),
          () => shapeSearch(closes, -5, 8, { maxMatches: 3, minScore: 0.5 }),
        ]) {
          const res = call();
          assert.ok(Array.isArray(res), 'answers with an array');
          for (const m of res) assert.ok(Number.isFinite(m.score), 'match scores are finite');
        }
      }
    } catch (err) {
      fail(seed, i, `analysis kernels (level ${level}, ${n} bars)`, err);
    }
  }
});

test('mergeOlderData keeps the tape sorted and deduplicated', () => {
  for (let i = 0; i < ITER; i++) {
    const seed = seedOf(i ^ 0x7f4a);
    // the existing side is the chart's own tape — ascending and one bar
    // per stamp (what setData guarantees); the backfill side arrives
    // as-is: unsorted, overlapping, junk included
    const newer = dedupByTime(genBars(seed, 1 + ((mulberry32(seed)() * 120) | 0), 1)
      .sort((a, b) => a.time - b.time));
    const older = genBars(seed ^ 0x333, 1 + ((mulberry32(seed ^ 2)() * 120) | 0), 1);
    try {
      const { bars: out, added } = mergeOlderData(newer, older);
      for (let k = 1; k < out.length; k++) {
        assert.ok(out[k].time > out[k - 1].time,
          `output not strictly ascending at ${k} (${out[k - 1].time} → ${out[k].time})`);
      }
      assert.ok(out.length === newer.length + added, 'added count matches the growth');
      assert.ok(added <= older.length, 'no phantom bars');
    } catch (err) {
      fail(seed, i, 'mergeOlderData', err);
    }
  }
});
