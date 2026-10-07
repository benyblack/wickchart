/* ==========================================================================
 * fuzz-gen — the shared deterministic engine behind both fuzz gates.
 *
 *   tests/fuzz.test.mjs   — property fuzz of the pure compute kernels
 *   e2e/fuzz.spec.mjs     — data/attrs/gestures against the live element
 *
 * Everything flows from a 32-bit seed through mulberry32: the same seed
 * regenerates the same bars, the same attribute writes, the same gesture
 * coordinates — which is what makes any failure replayable byte-exact:
 *
 *   WICK_FUZZ_SEED=<seed> npm test -- tests/fuzz.test.mjs
 *   WICK_FUZZ_SEED=<seed> npx playwright test e2e/fuzz.spec.mjs
 *
 * No shared state, no wall clock, no Math.random() — the generators are
 * pure functions of (seed, length).
 * ========================================================================== */

/** Deterministic 32-bit PRNG (mulberry32) — same stream on every machine. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Small seeded toolkit: floats, ints, picks, chances. */
export function makeRng(seed) {
  const next = mulberry32(seed);
  return {
    next,
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    seed,
  };
}

/**
 * Adversarial bars from a seed. `level` controls how hostile the tape gets:
 *   0 — a plausible walk (browser-safe: always renders)
 *   1 — plus scrambled/duplicated times, flat bars, missing volume
 *   2 — plus extreme magnitudes and zero/negative prices
 *   3 — plus non-finite OHLC and null fields (kernel-level poison; the
 *       element's ingestion never sees these — the compute fuzz does)
 * @param {number} seed
 * @param {number} n bar count
 * @param {0|1|2|3} level
 */
export function genBars(seed, n, level = 1) {
  const rng = makeRng(seed);
  const bars = [];
  let price = 10 ** rng.int(0, 4);
  let t = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    t += rng.int(1, 3) * 60_000;
    if (level >= 1 && rng.chance(0.05)) t -= rng.int(1, 5) * 60_000; // out of order
    if (level >= 1 && rng.chance(0.03)) t += 0; // duplicate stamp lands sometimes
    let open, high, low, close;
    if (level >= 1 && rng.chance(0.06)) {
      open = high = low = close = price; // flat bar
    } else {
      const vol = 10 ** rng.int(-3, 0);
      open = price;
      close = price * (1 + (rng.next() - 0.5) * vol);
      high = Math.max(open, close) * (1 + rng.next() * vol);
      low = Math.min(open, close) * (1 - rng.next() * vol);
      price = close;
    }
    if (level >= 2 && rng.chance(0.05)) {
      const extreme = rng.pick([1e-12, 1e12, 0, -price]);
      close = extreme;
    }
    if (level >= 3 && rng.chance(0.06)) {
      const poison = rng.pick([NaN, Infinity, -Infinity, null]);
      open = poison;
    }
    const bar = { time: t, open, high, low, close };
    if (level >= 3 && rng.chance(0.05)) bar.high = rng.pick([undefined, NaN]);
    if (!(level >= 1 && rng.chance(0.15))) bar.volume = rng.int(0, 5000); // sometimes missing
    bars.push(bar);
  }
  return bars;
}

/* -------------------- live-element scenarios (e2e) -------------------- */

const ATTR_POOLS = {
  type: ['candles', 'line', 'area', 'bars', 'hollow', 'heikin', 'steampunk', ''],
  theme: ['dark', 'light', 'not-a-theme'],
  log: ['', 'true', 'false'],
  indicators: [
    '', 'sma:20', 'rsi:14', 'bb:20 volume', 'macd:12/26/9', 'ichimoku',
    'expr:{close - sma(close,20)}', 'pexpr:{rsi(close,14)}',
    'vwap atr:14 stoch:14/3', 'sma:banana', 'volume rsi:2',
  ],
  volshading: ['', 'true', '30/70', 'nope'],
  stats: ['', 'true', 'false'],
  profile: ['', 'true', 'false'],
  annotations: ['', 'true', 'false'],
  preset: ['minimal', 'pro', ''],
};

/**
 * A whole live-element scenario from one seed: a browser-safe tape, then a
 * mixed script of attribute writes, streaming updates and gestures. The
 * gesture params (positions, deltas, key lists) are decided here too, so
 * the browser side just executes — same seed, same script, byte-exact.
 * @param {number} seed
 */
export function genScenario(seed) {
  const rng = makeRng(seed);
  const n = rng.int(2, 400);
  const ops = [];
  const nOps = rng.int(4, 10);
  const box = { x: 450, y: 230 }; // the fixture's chart is 900×460
  for (let k = 0; k < nOps; k++) {
    const kind = rng.next();
    if (kind < 0.45) {
      const name = rng.pick(Object.keys(ATTR_POOLS));
      ops.push({ t: 'attr', k: name, v: rng.pick(ATTR_POOLS[name]) });
    } else if (kind < 0.6) {
      // a streaming update on a fresh or forming stamp
      ops.push({ t: 'update', append: rng.chance(0.5) });
    } else if (kind < 0.75) {
      ops.push({
        t: 'wheel', x: rng.int(30, 870), y: rng.int(30, 430),
        dx: 0, dy: rng.pick([-120, -3, 3, 120, 600]),
      });
    } else if (kind < 0.9) {
      ops.push({
        t: 'drag', x0: rng.int(30, 700), y0: rng.int(30, 430),
        dx: rng.pick([-260, -40, 40, 260]), dy: rng.pick([-20, 0, 20]),
      });
    } else {
      ops.push({ t: 'keys', keys: rng.pick([
        ['ArrowLeft'], ['ArrowRight'], ['ArrowUp'], ['ArrowDown'],
        ['ArrowLeft', 'ArrowLeft', 'ArrowRight'], ['Home'], ['End'],
      ]) });
    }
  }
  return { seed, bars: genBars(seed ^ 0x9e3779b9, n, 1), ops, box };
}
