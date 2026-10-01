/* wickchart-share in a real browser: export a self-contained file from the
 * fixture page, open it from a blob URL in a fresh page (no server, no
 * network — exactly what a recipient does), and assert the chart paints
 * again with the same bars and the same view. */
import { test, expect } from '@playwright/test';

test('a shared file opens offline and paints the same chart', async ({ page, context }) => {
  await page.goto('/e2e/fixtures/chart.html');
  await page.waitForFunction(() => window.ready === true);

  const shareUrl = await page.evaluate(async () => {
    const { attachShare } = await import('/plugins/share/share.mjs');
    const share = attachShare(window.chart);
    const html = await share.exportChart(); // discovers modules via resource timing
    return URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  });
  expect(shareUrl).toMatch(/^blob:/);

  const shared = await context.newPage();
  // everything but the blob itself is blocked — the file must stand alone
  await shared.route('**/*', (route) =>
    route.request().url() === shareUrl ? route.continue() : route.abort(),
  );
  await shared.goto(shareUrl);

  await shared.waitForFunction(() => {
    const el = document.getElementById('chart');
    return el && el.data && el.data.length === 300;
  }, null, { timeout: 10_000 });
  const restored = await shared.evaluate(() => {
    const el = document.getElementById('chart');
    const cv = el.shadowRoot.querySelector('canvas');
    const { data } = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    let base = null;
    let inked = 0;
    for (let i = 0; i < data.length; i += 16) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      if (base === null) base = key;
      else if (key !== base) inked++;
    }
    return { bars: el.data.length, range: el.getVisibleRange(), type: el.type, inked };
  });
  expect(restored.bars).toBe(300);
  expect(restored.inked).toBeGreaterThan(5000); // a real paint, not an empty canvas
  expect(restored.type).toBe('candles');

  // the exported view round-trips: the fixture settles at the right edge
  const srcRange = await page.evaluate(() => window.chart.getVisibleRange());
  expect(restored.range.to).toBe(srcRange.to);
  await shared.close();
});
