/* ==========================================================================
 * Cross-symbol spread panes — setSeries + pexpr over the second symbol,
 * end to end: the pane exists, its values are the aligned difference, and
 * it autoscales to its own axis (never fighting the price scale).
 * ========================================================================== */
import { test, expect } from '@playwright/test';
import { openFixture } from './helpers.mjs';

test('pexpr over a registered series renders a spread pane with its own scale', async ({ page }) => {
  await openFixture(page, '?empty');
  await page.evaluate(async () => {
    const t0 = Date.UTC(2024, 0, 2);
    const mk = (base, drift, gapFrom) =>
      Array.from({ length: 150 }, (_, i) => {
        const close = base + Math.sin(i / 9) * 2 + i * drift;
        return { time: t0 + (i + gapFrom) * 60_000, open: close, high: close + 1, low: close - 1, close, volume: 100 };
      });
    window.chart.setData(mk(100, 0.1, 0)); // primary from bar 0
    window.chart.setSeries('eth', mk(60, 0.05, 25)); // eth starts 25 bars later → gap
    window.chart.setAttribute('indicators', 'pexpr:{close - eth_close}');
    await window.settle();
  });

  const res = await page.evaluate(() => {
    const chart = window.chart;
    const pane = chart._ind.panes[0];
    const series = chart._indicatorSeries(pane);
    const vals = series.lines[0].values;
    let nanCount = 0;
    for (const v of vals) if (Number.isNaN(v)) nanCount++;
    return {
      panes: chart._ind.panes.length,
      len: vals.length,
      nanCount,
      first: vals[30], // both symbols live by bar 30
      // the pane's own autoscale, not the price scale
      panePy: typeof chart._ly.panes[0].pyOf,
      mainScaleMax: chart._lastScale.max,
    };
  });
  expect(res.panes).toBe(1);
  expect(res.len).toBe(150);
  expect(res.nanCount).toBe(25); // exactly the offset gap
  expect(res.first).not.toBeNaN();
  // spot value: primary close at i=30 minus eth close at i=30
  const spot = await page.evaluate(() => {
    const d = window.chart.data;
    return +(d[30].close - window.chart._series.eth[5].close).toFixed(9);
  });
  expect(res.first).toBeCloseTo(spot, 6);
  expect(res.panePy).toBe('function');
});

test('clearSeries drops the aux data and the pane goes NaN', async ({ page }) => {
  await openFixture(page, '?empty');
  await page.evaluate(async () => {
    const t0 = Date.UTC(2024, 0, 2);
    const mk = (base) =>
      Array.from({ length: 60 }, (_, i) => {
        const close = base + (i % 7);
        return { time: t0 + i * 60_000, open: close, high: close, low: close, close, volume: 1 };
      });
    window.chart.setData(mk(100));
    window.chart.setSeries('eth', mk(60));
    window.chart.setAttribute('indicators', 'pexpr:{close - eth_close}');
    await window.settle();
  });
  const after = await page.evaluate(async () => {
    window.chart.clearSeries('eth');
    await window.settle();
    const pane = window.chart._ind.panes[0];
    const vals = window.chart._indicatorSeries(pane).lines[0].values;
    return { nan: vals.filter((v) => Number.isNaN(v)).length, len: vals.length };
  });
  expect(after.nan).toBe(after.len); // every value NaN with no aux data
});
