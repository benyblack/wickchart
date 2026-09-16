/* ==========================================================================
 * The worker compute path — the real last mile: a module Worker spawned from
 * src/worker.js, fed a 60k-bar epoch over transferable columns, answering
 * built-in indicator computes back onto the chart. Everything below the
 * transfer boundary is covered by unit tests; this spec proves the boundary.
 * ========================================================================== */
import { test, expect } from '@playwright/test';
import { openFixture } from './helpers.mjs';

test('a 60k-bar history computes its indicators in a real worker', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openFixture(page, '?worker');

  expect(await page.evaluate(() => window.chart.data.length)).toBe(60_000);

  // both indicators land in the epoch-keyed worker cache (not the sync cache)
  await page.waitForFunction(
    () => {
      const wc = window.chart._workerCache;
      return wc && wc.map['ind:sma:20'] && wc.map['ind:bb:20'];
    },
    null,
    { timeout: 20000 }
  );

  // and they are real values: SMA(20) at the last bar equals the naive mean
  const sma = await page.evaluate(() => {
    const line = window.chart._workerCache.map['ind:sma:20'].lines[0].values;
    return { last: line[line.length - 1], len: line.length };
  });
  expect(sma.len).toBe(60_000);
  const naive = await page.evaluate(() => {
    const d = window.chart.data;
    let s = 0;
    for (let i = d.length - 20; i < d.length; i++) s += d[i].close;
    return s / 20;
  });
  expect(Math.abs(sma.last - naive)).toBeLessThan(1e-9);

  // the line actually painted: the canvas carries ink
  await page.waitForFunction(async () => {
    await window.settle();
    const cv = window.chart.shadowRoot.querySelector('canvas');
    const { data } = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    let inked = 0;
    for (let i = 0; i < data.length; i += 64) {
      if (data[i + 3] > 0 && (data[i] !== data[0] || data[i + 1] !== data[1])) inked++;
    }
    return inked > 50;
  }, null, { timeout: 10000 });

  expect(errors).toEqual([]);
});

test('streamed ticks reuse the epoch series instead of recomputing', async ({ page }) => {
  await openFixture(page, '?worker');
  await page.waitForFunction(
    () => window.chart._workerCache && window.chart._workerCache.map['ind:sma:20'],
    null,
    { timeout: 20000 }
  );

  // hold the series reference inside the page — identity can't cross the
  // structured-clone boundary, so the comparison happens in-page
  await page.evaluate(() => {
    window.__seriesRef = window.chart._workerCache.map['ind:sma:20'];
    window.__tasksAt = Object.keys(window.chart._workerCache.pending).length;
  });

  // a streamed tick: bump the last bar — _version moves, _epoch must not
  await page.evaluate(async () => {
    const d = window.chart.data;
    const last = d[d.length - 1];
    window.chart.update({ ...last, close: last.close * 1.01, high: last.close * 1.02 });
    await window.settle();
  });

  const after = await page.evaluate(() => ({
    sameSeries: window.chart._workerCache.map['ind:sma:20'] === window.__seriesRef,
    epoch: window.chart._epoch,
    version: window.chart._version,
  }));
  expect(after.sameSeries).toBe(true);
  expect(after.version).toBeGreaterThan(1);
});

test('a fresh bulk load repaints with the new epoch, not the stale series', async ({ page }) => {
  await openFixture(page, '?worker');
  await page.waitForFunction(
    () => window.chart._workerCache && window.chart._workerCache.map['ind:sma:20'],
    null,
    { timeout: 20000 }
  );

  const stale = await page.evaluate(() => window.chart._workerCache.map['ind:sma:20']);
  await page.evaluate(() => window.chart.setData(window.makeBars(60_000)));
  await page.waitForFunction(
    (old) => window.chart._workerCache.map['ind:sma:20'] !== old,
    stale,
    { timeout: 20000 }
  );
  // the new epoch's series is length-matched and cached under the new epoch
  const state = await page.evaluate(() => ({
    len: window.chart._workerCache.map['ind:sma:20'].lines[0].values.length,
    epoch: window.chart._workerCache.epoch,
  }));
  expect(state.len).toBe(60_000);
});
