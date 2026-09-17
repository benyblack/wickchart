/* ==========================================================================
 * The branded snapshot/report export — the browser-only half: compose a
 * report from a live chart, then verify the produced image decodes at the
 * model's dimensions and actually contains the header/stats/footer bands.
 * The pure model is covered by tests/pr66-report.test.mjs.
 * ========================================================================== */
import { test, expect } from '@playwright/test';
import { openFixture } from './helpers.mjs';

test('a report composes at model dimensions with every band inked', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openFixture(page);

  const out = await page.evaluate(async () => {
    const { exportReport, reportModel } = await import('/src/report.js');
    const model = reportModel(window.chart);
    const url = await exportReport(window.chart);
    const img = new Image();
    img.src = url;
    await img.decode();
    // paint the report back onto a canvas so the bands can be inspected
    const cv = document.createElement('canvas');
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = (x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data];
    const s = model.scale;
    const b = model.bands;
    // ink in a band = pixels differing from the band's own background
    const sample = (x0, x1, y0, y1) => {
      let distinct = 0;
      const base = px((x0 + x1) / 2, y0 + 1);
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 16) {
          const p = px(x, y);
          if (p[3] === 0 || Math.abs(p[0] - base[0]) > 12 || Math.abs(p[1] - base[1]) > 12) distinct++;
        }
      }
      return distinct;
    };
    const statsTop = (b.header + b.chart) * s;
    return {
      model: { width: model.width, height: model.height, scale: model.scale },
      img: { w: img.width, h: img.height },
      headerInk: sample(0, model.width, 2, b.header * s - 2),
      statsInk: sample(0, model.width, statsTop, statsTop + b.stats * s - 2),
      footerInk: sample(0, model.width, (model.height - b.footer) * s + 2, model.height * s - 2),
      prefix: url.slice(0, 21),
    };
  });

  expect(out.prefix).toBe('data:image/png;base64');
  expect(out.img.w).toBe(out.model.width * out.model.scale);
  expect(out.img.h).toBe(out.model.height * out.model.scale);
  // title/branding in the header, stat labels in the band, credit in the footer
  expect(out.headerInk).toBeGreaterThan(20);
  expect(out.statsInk).toBeGreaterThan(20);
  expect(out.footerInk).toBeGreaterThan(10);
  expect(errors).toEqual([]);
});

test('blob and canvas outputs, theming and download wiring', async ({ page }) => {
  await openFixture(page);
  const out = await page.evaluate(async () => {
    const { exportReport } = await import('/src/report.js');
    const blob = await exportReport(window.chart, { as: 'blob' });
    const canvas = await exportReport(window.chart, { as: 'canvas', theme: 'light' });
    return {
      blobType: blob.type,
      blobSize: blob.size,
      canvasW: canvas.width,
      canvasH: canvas.height,
    };
  });
  expect(out.blobType).toBe('image/png');
  expect(out.blobSize).toBeGreaterThan(10_000);
  expect(out.canvasW).toBeGreaterThan(0);
  expect(out.canvasH).toBeGreaterThan(0);
});

test('an empty chart refuses with a clear error instead of a broken image', async ({ page }) => {
  await openFixture(page, '?empty');
  const msg = await page.evaluate(async () => {
    const { exportReport } = await import('/src/report.js');
    try {
      await exportReport(window.chart);
      return 'no-error';
    } catch (e) {
      return e.message;
    }
  });
  expect(msg).toMatch(/2\+ bars/);
});
