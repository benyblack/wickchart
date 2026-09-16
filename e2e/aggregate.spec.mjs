/* ==========================================================================
 * Information-based bar aggregation — PR #61 exercised end to end over the
 * offline path: <wick-feed demo aggregate> must build strictly-increasing
 * OHLCV bars from synthetic prints and keep streaming new ones.
 * ========================================================================== */
import { test, expect } from '@playwright/test';

async function openAggFeed(page) {
  await page.goto('/e2e/fixtures/feed.html');
  await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
}

test('the aggregate feed reports live with a populated chart', async ({ page }) => {
  await openAggFeed(page);
  expect(await page.getAttribute('#feed', 'status')).toBe('live');
  const n = await page.evaluate(() => window.chart.data.length);
  expect(n).toBeGreaterThanOrEqual(50);
});

test('aggregated bars are well-formed and strictly increasing', async ({ page }) => {
  await openAggFeed(page);
  const bars = await page.evaluate(() => window.chart.data);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
    expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
    expect(b.volume).toBeGreaterThan(0);
    if (i) expect(b.time).toBeGreaterThan(bars[i - 1].time);
  }
});

test('streaming closes new dollar bars without user input', async ({ page }) => {
  await openAggFeed(page);
  const n0 = await page.evaluate(() => window.chart.data.length);
  // a burst of synthetic prints lands every 650 ms; $20k bars close every
  // couple of bursts — 20 s is far beyond what a healthy run needs
  await page.waitForFunction(
    (start) => window.chart.data.length > start,
    n0,
    { timeout: 20000 }
  );
});
