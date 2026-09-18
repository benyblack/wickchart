/* ==========================================================================
 * Streaming and history in a live element — PR #57 (one bar per timestamp,
 * binary-search inserts) exercised end to end.
 * ========================================================================== */
import { test, expect } from '@playwright/test';
import {
  openFixture,
  visibleRange,
  snapshotSettledCanvas,
  expectCanvasChanged,
} from './helpers.mjs';

const times = (page) => page.evaluate(() => window.chart.data.map((b) => b.time));
const closes = (page) => page.evaluate(() => window.chart.data.map((b) => b.close));

test.describe('data ingestion', () => {
  test('setData keeps one bar per timestamp, last copy wins', async ({ page }) => {
    await openFixture(page, '?empty');
    const t = await page.evaluate(() => {
      const t0 = Date.UTC(2024, 0, 2);
      const bar = (time, close) => ({ time, open: close, high: close, low: close, close, volume: 1 });
      // The REST tail and the websocket that takes over overlap: the same
      // candle arrives twice, the later copy corrected.
      window.chart.setData([bar(t0, 10), bar(t0 + 60_000, 11), bar(t0 + 60_000, 12), bar(t0 + 120_000, 13)]);
      return t0;
    });
    expect(await times(page)).toEqual([t, t + 60_000, t + 120_000]);
    expect(await closes(page)).toEqual([10, 12, 13]);
  });

  test('setData sorts a shuffled history', async ({ page }) => {
    await openFixture(page, '?empty');
    await page.evaluate(() => {
      const bars = window.makeBars(50);
      const shuffled = [bars[10], bars[3], bars[40], bars[0], bars[25]];
      window.chart.setData(shuffled);
    });
    const t = await times(page);
    expect(t).toHaveLength(5);
    expect([...t].sort((a, b) => a - b)).toEqual(t);
  });

  test('a live candle replaces the last bar and repaints', async ({ page }) => {
    await openFixture(page);
    const before = await page.evaluate(() => window.chart.data.length);
    await snapshotSettledCanvas(page);

    await page.evaluate(async () => {
      const last = window.chart.data.at(-1);
      // Same timestamp, a much higher close — a tick on the forming candle.
      window.chart.update({ ...last, close: last.high * 1.05, high: last.high * 1.05 });
      await window.settle();
    });

    expect(await page.evaluate(() => window.chart.data.length)).toBe(before);
    await expectCanvasChanged(page);
  });

  // PR #78 — the axis width is measured from the formatted last close, so
  // ticks flipping the grouping boundary used to flip plotRight (and with
  // it every candle) a few px at a time: the "shaking" live chart.
  test('rapid ticks never wobble the price axis', async ({ page }) => {
    await openFixture(page, '?empty');
    const widths = await page.evaluate(async () => {
      const t0 = Date.UTC(2024, 0, 2);
      const bars = [];
      for (let i = 0; i < 80; i++) {
        const c = 989 + (i % 5) * 0.1;
        bars.push({ time: t0 + i * 60_000, open: c, high: c + 0.4, low: c - 0.4, close: c, volume: 1 });
      }
      window.chart.setData(bars);
      await window.settle();
      // "999.99" (6 chars) vs "1,000.01" (8 chars with the group comma) —
      // a width jump in any font. The last close flaps across it, the way a
      // high-frequency pair hovers around a round number.
      const out = [];
      const last = () => window.chart.data.at(-1);
      for (let k = 0; k < 20; k++) {
        const close = k % 2 ? 999.99 : 1000.01;
        window.chart.update({ ...last(), close });
        await window.settle();
        out.push(window.layout().priceW);
      }
      return out;
    });
    // Grow to the wide width once, then hold it for the whole flap — one
    // distinct value ever. (Before the fix: alternated on every tick.)
    expect(new Set(widths).size).toBe(1);
  });

  test('a newer candle appends and the chart follows it', async ({ page }) => {
    await openFixture(page);
    const before = await visibleRange(page);
    const count = await page.evaluate(() => window.chart.data.length);

    await page.evaluate(async () => {
      const last = window.chart.data.at(-1);
      window.chart.update({ ...last, time: last.time + 60_000 });
      await window.settle();
    });

    expect(await page.evaluate(() => window.chart.data.length)).toBe(count + 1);
    const after = await visibleRange(page);
    expect(after.to).toBeGreaterThan(before.to);
  });

  test('a backfilled candle lands in order, not at the end', async ({ page }) => {
    await openFixture(page);
    const t = await page.evaluate(() => {
      const d = window.chart.data;
      // Halfway through the series, on a timestamp that does not exist yet.
      const gap = d[20].time + 30_000;
      window.chart.update({ time: gap, open: 1, high: 1, low: 1, close: 1, volume: 1 });
      return gap;
    });
    const all = await times(page);
    expect([...all].sort((a, b) => a - b)).toEqual(all);
    expect(all.indexOf(t)).toBe(21);
  });

  test('a historical correction replaces in place', async ({ page }) => {
    await openFixture(page);
    const count = await page.evaluate(() => window.chart.data.length);
    await page.evaluate(() => {
      const b = window.chart.data[7];
      window.chart.update({ ...b, close: 999 });
    });
    expect(await page.evaluate(() => window.chart.data.length)).toBe(count);
    expect(await page.evaluate(() => window.chart.data[7].close)).toBe(999);
  });

  test('a large backfill stays ordered', async ({ page }) => {
    await openFixture(page);
    await page.evaluate(() => {
      const first = window.chart.data[0].time;
      // 200 older candles, delivered newest-first — the worst order for an
      // insert that scans backwards.
      for (let i = 1; i <= 200; i++) {
        const time = first - i * 60_000;
        window.chart.update({ time, open: 5, high: 5, low: 5, close: 5, volume: 1 });
      }
    });
    const all = await times(page);
    expect(all).toHaveLength(500);
    expect([...all].sort((a, b) => a - b)).toEqual(all);
    expect(new Set(all).size).toBe(all.length);
  });
});
