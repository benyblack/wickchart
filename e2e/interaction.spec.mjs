/* ==========================================================================
 * Wheel, pointer and keyboard input against a real canvas.
 *
 * The Node suite drives the handlers with hand-built event objects; only a
 * browser tells us the listeners are actually wired to the canvas, that
 * `preventDefault` on a passive-false wheel listener holds, and that the
 * viewport maths survives real client coordinates.
 * ========================================================================== */
import { test, expect } from '@playwright/test';
import {
  openFixture,
  canvasBox,
  visibleRange,
  snapshotSettledCanvas,
  expectCanvasUnchanged,
  expectCanvasChanged,
} from './helpers.mjs';

const span = (r) => r.to - r.from;

test.describe('interaction', () => {
  test('wheel over the canvas zooms in and out', async ({ page }) => {
    await openFixture(page);
    const box = await canvasBox(page);
    const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const start = await visibleRange(page);

    await page.mouse.move(mid.x, mid.y);
    await page.mouse.wheel(0, -600);
    const zoomedIn = await visibleRange(page);
    expect(span(zoomedIn)).toBeLessThan(span(start));

    await page.mouse.wheel(0, 900);
    const zoomedOut = await visibleRange(page);
    expect(span(zoomedOut)).toBeGreaterThan(span(zoomedIn));
  });

  test('the page does not scroll while zooming the chart', async ({ page }) => {
    await openFixture(page);
    // Make the document scrollable so a leaked wheel event would be visible.
    await page.evaluate(() => (document.body.style.paddingBottom = '3000px'));
    const box = await canvasBox(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 400);
    await page.waitForFunction(() => window.chart.getVisibleRange() !== null);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('dragging pans the visible window', async ({ page }) => {
    await openFixture(page);
    const box = await canvasBox(page);
    const y = box.y + box.height / 2;
    // Zoom in first: fitted-to-all data has nowhere to pan to.
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.wheel(0, -900);
    const before = await visibleRange(page);

    await page.mouse.move(box.x + box.width * 0.7, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.3, y, { steps: 12 });
    await page.mouse.up();

    const after = await visibleRange(page);
    // Dragging left walks the window forward in time; the span is unchanged.
    expect(after.from).toBeGreaterThan(before.from);
    expect(Math.abs(span(after) - span(before))).toBeLessThanOrEqual(span(before) * 0.1);
  });

  test('a pan emits wick:range', async ({ page }) => {
    await openFixture(page);
    const box = await canvasBox(page);
    const y = box.y + box.height / 2;
    await page.evaluate(() => (window.events.range.length = 0));

    await page.mouse.move(box.x + box.width * 0.7, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, y, { steps: 8 });
    await page.mouse.up();

    const detail = await page.evaluate(() => window.events.range.at(-1));
    expect(detail).toBeTruthy();
    expect(typeof detail.from).toBe('number');
    expect(detail.to).toBeGreaterThan(detail.from);
  });

  test('hovering draws a crosshair, leaving clears it', async ({ page }) => {
    await openFixture(page);
    const box = await canvasBox(page);
    await snapshotSettledCanvas(page, 'clean');

    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
    await page.waitForFunction(() => window.events.crosshair.at(-1) != null);
    await expectCanvasChanged(page, 'clean');
    // The crosshair reports the bar under the pointer, not just a line.
    const detail = await page.evaluate(() => window.events.crosshair.at(-1));
    expect(detail.bar).toBeTruthy();
    expect(typeof detail.bar.close).toBe('number');

    // Leaving the canvas fires crosshair(null) and restores the clean frame.
    await page.mouse.move(box.x + box.width / 2, box.y - 60);
    await page.waitForFunction(() => window.events.crosshair.at(-1) === null);
    await expectCanvasUnchanged(page, 'clean');
  });

  // The offscreen hover layer: a pointer crossing the chart repaints the
  // crosshair overlay alone — the series/axes beneath must not re-render.
  test('hovering repaints only the overlay, never the full chart', async ({ page }) => {
    await openFixture(page);
    const box = await canvasBox(page);
    await page.evaluate(() => {
      const chart = window.chart;
      const orig = chart._render.bind(chart);
      window.__renderCount = 0;
      chart._render = () => {
        window.__renderCount++;
        return orig();
      };
    });
    for (let k = 1; k <= 12; k++) {
      await page.mouse.move(box.x + box.width * (0.2 + 0.05 * k), box.y + box.height * 0.5);
      await page.evaluate(() => window.settle());
    }
    const count = await page.evaluate(() => window.__renderCount);
    expect(count).toBe(0); // hover alone never schedules a full frame
    // …and the crosshair was really there while it happened
    expect(await page.evaluate(() => window.events.crosshair.length)).toBeGreaterThan(0);
  });

  test('double-click refits the whole series', async ({ page }) => {
    await openFixture(page);
    const box = await canvasBox(page);
    const fitted = await visibleRange(page);

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -800);
    expect(span(await visibleRange(page))).toBeLessThan(span(fitted));

    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    const refit = await visibleRange(page);
    expect(span(refit)).toBeCloseTo(span(fitted), -3);
  });
});
