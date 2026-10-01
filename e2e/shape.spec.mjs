/* Shape & pattern search in a real browser: the wick:shape event, the
 * rendered match/query bands, and clearing. The math itself is covered by
 * the Node suite (differential vs brute force + golden vectors); this is
 * the upgrade/Canvas/paint side of the contract. */
import { test, expect } from '@playwright/test';
import {
  openFixture, snapshotSettledCanvas, expectCanvasChanged, expectCanvasUnchanged,
} from './helpers.mjs';

test('findShape paints match bands, fires wick:shape, and clears cleanly', async ({ page }) => {
  await openFixture(page);
  await snapshotSettledCanvas(page, 'before');

  const res = await page.evaluate(() => {
    const d = window.chart._data;
    return window.chart.findShape({ from: d[120].time, to: d[145].time });
  });

  // the fixture's 300-bar random walk always has some correlated window
  expect(res, 'a result object comes back').not.toBeNull();
  expect(res.matches.length).toBeGreaterThanOrEqual(1);
  for (const m of res.matches) {
    expect(m.score).toBeLessThanOrEqual(1);
    expect(m.score).toBeGreaterThanOrEqual(-1);
    expect(m.to).toBeGreaterThan(m.from);
  }
  expect(res.matches.map((m) => m.from)).not.toContain(res.query.from);

  await expectCanvasChanged(page, 'before', 0.005); // the bands painted
  expect((await page.evaluate(() => window.events.shape)).length).toBe(1);
  expect((await page.evaluate(() => window.events.shape))[0].matches.length)
    .toBe(res.matches.length);

  await page.evaluate(() => window.chart.clearShape());
  await expectCanvasUnchanged(page, 'before'); // the picture is restored
  expect(await page.evaluate(() => window.chart.shapeResult)).toBeNull();
});

test('findShape without a range or brush selection is a documented no-op', async ({ page }) => {
  await openFixture(page);
  expect(await page.evaluate(() => window.chart.findShape())).toBeNull();
  expect(await page.evaluate(() => window.events.shape.length)).toBe(0);
});
