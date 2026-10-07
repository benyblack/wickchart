/* ==========================================================================
 * The live-element fuzz — the browser half of the fuzz gate (the pure
 * kernels are fuzzed in tests/fuzz.test.mjs). Random tapes, random
 * attribute writes and random gesture scripts run against a real upgraded
 * <wick-chart> in a real browser, and after every step the same invariants
 * hold: no page errors, the tape stays strictly ascending, the visible
 * range stays finite and ordered, and the chart paints.
 *
 * Everything derives from one 32-bit seed (tests/fuzz-gen.mjs): same seed,
 * same bars, same attribute writes, same gesture coordinates — so any
 * failure replays byte-exact:
 *
 *   WICK_FUZZ_SEED=123456789 npx playwright test e2e/fuzz.spec.mjs
 *   WICK_FUZZ_ITER=200 npx playwright test e2e/fuzz.spec.mjs  # dig deeper
 *
 * CI runs the default iteration budget (24); locally go deeper.
 * ========================================================================== */
import { test } from '@playwright/test';
import { expect } from '@playwright/test';
import { genScenario } from '../tests/fuzz-gen.mjs';
import { openFixture } from './helpers.mjs';

const ITER = Number(process.env.WICK_FUZZ_ITER || (process.env.CI ? 24 : 40));
const REPLAY = Number(process.env.WICK_FUZZ_SEED || 0);
const BASE = REPLAY || ((Date.now() ^ (process.pid << 8)) >>> 0);

/** The invariants, evaluated in the page after each step. */
const PROBE = `(() => {
  const c = window.chart;
  const d = c.data;
  let ascending = true;
  for (let i = 1; i < d.length; i++) {
    if (!(d[i].time > d[i - 1].time)) { ascending = false; break; }
  }
  const r = d.length >= 2 ? c.getVisibleRange() : null;
  return {
    n: d.length,
    ascending,
    hasRange: !!r,
    rangeOk: !!r && Number.isFinite(r.from) && Number.isFinite(r.to) && r.from <= r.to,
  };
})()`;

test(`fuzz: ${ITER} random data/attr/gesture scenarios keep the chart honest`, async ({ page }) => {
  // the budget scales with the dig depth — CI's 24 needs ~20 s, a deep
  // local run needs proportionally more
  test.setTimeout(30_000 + ITER * 1000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('console', (m) => {
    // resource-loading noise (a missing favicon is not a chart defect);
    // script/runtime errors from the page still count
    if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) {
      errors.push('console: ' + m.text());
    }
  });

  await openFixture(page, '?empty');
  if (!REPLAY) console.log(`fuzz base seed: ${BASE} (replay: WICK_FUZZ_SEED=${BASE} npx playwright test e2e/fuzz.spec.mjs)`);

  for (let i = 0; i < ITER; i++) {
    const seed = REPLAY ? BASE : (Math.imul(BASE ^ (i * 0x9e37), 0x85ebca6b) >>> 0);
    const scenario = genScenario(seed);
    const where = `scenario ${i} (seed ${seed})`;

    await page.evaluate((bars) => window.chart.setData(bars), scenario.bars);
    await page.evaluate(() => window.settle());

    for (let k = 0; k < scenario.ops.length; k++) {
      const op = scenario.ops[k];
      const at = `${where}, op ${k} (${JSON.stringify(op).slice(0, 90)})`;
      if (op.t === 'attr') {
        await page.evaluate(([name, v]) => window.chart.setAttribute(name, v), [op.k, op.v]);
      } else if (op.t === 'update') {
        await page.evaluate((append) => {
          const d = window.chart.data;
          const last = d[d.length - 1];
          const prev = d[d.length - 2] || last;
          const dt = Math.max(60_000, last.time - prev.time);
          const close = last.close * (1 + (Math.random() - 0.5) * 0.01);
          window.chart.update(append
            ? { time: last.time + dt, open: last.close, high: Math.max(last.close, close), low: Math.min(last.close, close), close, volume: 100 }
            : { time: last.time, open: last.open, high: Math.max(last.high, close), low: Math.min(last.low, close), close, volume: (last.volume || 0) + 50 });
        }, op.append);
      } else if (op.t === 'wheel') {
        await page.mouse.move(op.x, op.y);
        await page.mouse.wheel(op.dx, op.dy);
      } else if (op.t === 'drag') {
        await page.mouse.move(op.x0, op.y0);
        await page.mouse.down();
        for (let s = 1; s <= 3; s++) {
          await page.mouse.move(op.x0 + (op.dx * s) / 3, op.y0 + (op.dy * s) / 3);
        }
        await page.mouse.up();
      } else if (op.t === 'keys') {
        for (const key of op.keys) await page.keyboard.press(key);
      }
      await page.evaluate(() => window.settle());

      const probe = await page.evaluate(`(${PROBE})`);
      expect(probe.ascending, `tape order broke at ${at}`) .toBe(true);
      if (probe.n >= 2) {
        expect(probe.hasRange, `no visible range with data at ${at}`) .toBe(true);
        expect(probe.rangeOk, `visible range not finite/ordered at ${at}`) .toBe(true);
      }
      expect(errors, `page errors at ${at}`) .toEqual([]);
    }

    // the scenario must end painted — a real render, not an empty canvas
    const inked = await page.evaluate(() => {
      const cv = window.chart.shadowRoot.querySelector('canvas');
      const { data } = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
      let base = null;
      let inked = 0;
      for (let i = 0; i < data.length; i += 16) {
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        if (base === null) base = key;
        else if (key !== base) inked++;
      }
      return inked;
    });
    expect(inked, `the chart stopped painting by the end of ${where}`).toBeGreaterThan(20);
  }
});
