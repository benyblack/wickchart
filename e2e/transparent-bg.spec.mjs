/*
 * A transparent --wick-bg is a legitimate theme (charts embedded on a card
 * with their own surface). The render loop used to rely on the background
 * fill as its only clear — with a transparent bg that fill paints nothing,
 * so every redraw stacked on the previous frame: toggles, pans and live
 * ticks accumulated into ghost candles and smeared axis labels (first seen
 * in the wild on tick.market's coin pages). _render() now clearRect()s
 * before painting the background; this spec pins that contract to a real
 * canvas: pixels inked by one frame must not survive the next.
 */
import { test, expect } from '@playwright/test';
import { openFixture } from './helpers.mjs';

test('a transparent background still clears between redraws', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openFixture(page, '');

  // Transparent bg, force the cached palette to be re-read, redraw.
  await page.evaluate(async () => {
    const c = window.chart;
    c.style.setProperty('--wick-bg', 'transparent');
    c._pal = null;
    c._invalidate();
    await window.settle();
  });

  // Frame 1: collect a sample of strongly opaque pixels (the ink that would
  // ghost). Sample every 16th pixel — plenty of signal.
  const frame1 = await page.evaluate(() => {
    const cv = window.chart.shadowRoot.querySelector('canvas');
    const { data } = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    const px = [];
    for (let i = 3; i < data.length; i += 64) {
      if (data[i] > 200) px.push((i - 3) / 4);
    }
    return { count: px.length, px };
  });
  expect(frame1.count, 'frame 1 must have ink that could ghost').toBeGreaterThan(100);

  // Frame 2: pan the view hard left — the same canvas now paints a
  // completely different frame, leaving most of frame 1's ink positions
  // empty. A chart that never clears keeps ~all of them. (auto is disabled
  // first: with the right edge auto-pinned, the next render would snap the
  // view back and re-ink the same pixels legitimately.)
  await page.evaluate(async () => {
    const c = window.chart;
    c.setAttribute('auto', 'false');
    c._view.rightIndex = 3;
    c._invalidate();
    await window.settle();
  });

  const survivors = await page.evaluate((px) => {
    const cv = window.chart.shadowRoot.querySelector('canvas');
    const { data } = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    let n = 0;
    for (const p of px) if (data[p * 4 + 3] > 200) n++;
    return n;
  }, frame1.px);

  // The new frame legitimately re-inks some of the same positions (grid,
  // axis, last-price line) — but nowhere near all of them.
  expect(
    survivors / frame1.count,
    'old-frame pixels must not survive the redraw',
  ).toBeLessThan(0.2);
  expect(errors).toEqual([]);
});
