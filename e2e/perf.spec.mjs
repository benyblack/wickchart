/* ==========================================================================
 * Perf-budget gate — keeps "a full render fits the frame budget" an enforced
 * invariant instead of a README claim. The Node suite gates bytes
 * (tests/size-budget.test.mjs); this gates milliseconds, which needs a real
 * canvas — so it lives here, inside the CI browser job, and fails the merge
 * like any other test.
 *
 * The bars come straight from the roadmap's standing definition of green:
 *   < 1 ms default view, < 8 ms max zoom-out.
 *
 * Method — batches and medians, not one sample:
 *   - One _render() call is sub-millisecond, below Chrome's 100 µs timer
 *     quantization — a single timing is mostly noise. Each sample is
 *     therefore the average of 5 back-to-back renders (12 batches), read as
 *     one median.
 *   - CI runners are shared and 1.5–2.5× slower than a desktop, so the
 *     gate reads the median, which a neighbor test or a GC sprint cannot
 *     move — only a real regression can. p95 and max ride along in the
 *     failure message for diagnosis; the budget is the median, not the tail.
 *   - The whole run is one evaluate callback — one task — so no rAF or
 *     event can interleave and pollute the samples.
 *
 * Scenarios (candles + volume, the fixture default — no indicators, whose
 * compute is cached per data version and thus not part of the render path):
 *   - default view, 50k-bar history, ~150 bars visible. Also guards the
 *     "flat in store size" claim: an accidental O(bars) render pass blows
 *     this budget immediately.
 *   - max zoom-out, 50k-bar history, every bar visible — the README's
 *     heaviest documented row, exercising the per-pixel-column downsampling
 *     that bounds render cost by screen width, not history length.
 *
 * Calibrated (desktop Chromium, 900×460 fixture): default view median
 * ~0.12 ms, max zoom-out ~1.4 ms — the budgets carry 5–8× headroom, which
 * is the margin a 2× slower shared CI runner needs while a 2× regression
 * still fails.
 *
 * If this fails because of an intentional change, raise the budget in its
 * own commit and say why in the message — the same rule the size budget
 * follows. The diff IS the perf conversation.
 * ========================================================================== */
import { test, expect } from '@playwright/test';
import { openFixture } from './helpers.mjs';

const WARMUP = 10;
const BATCHES = 12;
const CALLS_PER_BATCH = 5;

/** 50k bars: enough that an O(bars) regression cannot hide behind the budget. */
const BARS = 50_000;

/**
 * Warm up, then time batches of synchronous full `_render()` passes in-page
 * and reduce to median/p95/max of the per-render averages.
 * @param {import('@playwright/test').Page} page
 */
export async function timeRenders(page) {
  return page.evaluate(({ warmup, batches, calls }) => {
    const chart = window.chart;
    for (let i = 0; i < warmup; i++) chart._render();
    const t = [];
    for (let b = 0; b < batches; b++) {
      const t0 = performance.now();
      for (let i = 0; i < calls; i++) chart._render();
      t.push((performance.now() - t0) / calls);
    }
    t.sort((a, b) => a - b);
    const at = (q) => t[Math.min(t.length - 1, Math.floor(q * t.length))];
    return { median: at(0.5), p95: at(0.95), max: t[t.length - 1], n: t.length };
  }, { warmup: WARMUP, batches: BATCHES, calls: CALLS_PER_BATCH });
}

/** The failure text — full stats, the budget, and the raise-in-its-own-commit rule. */
const fail = (scene, s, budget) =>
  `${scene}: median ${s.median.toFixed(3)} ms over ${s.n} samples ` +
  `(p95 ${s.p95.toFixed(3)} ms, max ${s.max.toFixed(3)} ms) — budget ${budget} ms\n` +
  'If this growth is intentional, raise the budget in e2e/perf.spec.mjs in a dedicated commit explaining why.';

/**
 * Assert the median fits the budget, and print the reading either way —
 * green runs log one line, so drift is visible in CI history before it
 * becomes a failure.
 */
async function expectWithinBudget(page, scene, budget) {
  const s = await timeRenders(page);
  console.log(
    `perf: ${scene} median ${s.median.toFixed(3)} ms ` +
      `(p95 ${s.p95.toFixed(3)}, max ${s.max.toFixed(3)}) — budget ${budget} ms`
  );
  expect(s.median, fail(scene, s, budget)).toBeLessThan(budget);
}

test.describe('perf budget', () => {
  test('default-view render stays under 1 ms (50k bars, candles + volume)', async ({ page }) => {
    await openFixture(page);
    await page.evaluate(async (n) => {
      window.chart.setData(window.makeBars(n));
      await window.settle();
    }, BARS);
    await expectWithinBudget(page, 'default view', 1);
  });

  test('max zoom-out render stays under 8 ms (50k bars, columnar path)', async ({ page }) => {
    await openFixture(page);
    await page.evaluate(async (n) => {
      const bars = window.makeBars(n);
      window.chart.setData(bars);
      // Let the post-setData fit land first — the next render applies
      // _applyFit() (needsFit), which would stomp a range set before it.
      await window.settle();
      // Zoom all the way out: the full history in one view.
      window.chart.setVisibleRange({ from: bars[0].time, to: bars[bars.length - 1].time });
      await window.settle();
    }, BARS);
    await expectWithinBudget(page, 'max zoom-out', 8);
  });
});
