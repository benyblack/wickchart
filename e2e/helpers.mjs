/* Shared helpers for the browser suite. */
import { expect } from '@playwright/test';

/**
 * Open the chart fixture and wait until the element has upgraded, ingested
 * its data and painted a frame.
 * @param {import('@playwright/test').Page} page
 * @param {string} [query] e.g. '?empty'
 */
export async function openFixture(page, query = '') {
  await page.goto('/e2e/fixtures/chart.html' + query);
  await page.waitForFunction(() => window.ready === true);
  return page.locator('#chart');
}

/** The chart's canvas — Playwright's CSS engine pierces the open shadow root. */
export const canvasOf = (page) => page.locator('#chart canvas').first();

/** Bounding box of the canvas, failing loudly rather than returning null. */
export async function canvasBox(page) {
  const box = await canvasOf(page).boundingBox();
  expect(box, 'canvas should have a layout box').not.toBeNull();
  return box;
}

/** The element's current visible range, after letting a frame land. */
export async function visibleRange(page) {
  return page.evaluate(async () => {
    await window.settle();
    return window.chart.getVisibleRange();
  });
}

/**
 * Count non-background pixels in the canvas. A chart that "mounted" but drew
 * nothing still has a canvas of the right size — this is what distinguishes
 * a real render from an empty one.
 * @returns {Promise<number>}
 */
export function inkedPixels(page) {
  return page.evaluate(() => {
    const cv = window.chart.shadowRoot.querySelector('canvas');
    const { data } = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    // Sample every 4th pixel — enough signal, a quarter of the work.
    let base = null;
    let inked = 0;
    for (let i = 0; i < data.length; i += 16) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      if (base === null) base = key;
      else if (key !== base) inked++;
    }
    return inked;
  });
}

/*
 * Comparing frames: Chrome dithers the panel gradient, so two paints of the
 * *same* state routinely differ by ±1 in one channel across the whole canvas.
 * Exact pixel equality therefore fails on an unchanged chart. Every
 * comparison here is a tolerance diff instead: a pixel counts as changed only
 * when a channel moves by more than `tol` (default 3), and the result is the
 * fraction of pixels that moved. Real chart marks move whole channels at
 * once, so the signal is nowhere near the noise floor.
 *
 * The pixels never leave the page — only the ratio crosses the wire.
 *
 * The picture is a stack now (main frame + offscreen hover layer), so
 * snapshots and diffs composite every canvas in the shadow root — what the
 * eye sees, not just the bottom sheet.
 */

/** Composite all chart canvases (main + overlays) into one ImageData. */
function grabComposite() {
  const cvs = [...window.chart.shadowRoot.querySelectorAll('canvas')];
  const off = document.createElement('canvas');
  off.width = cvs[0].width;
  off.height = cvs[0].height;
  const c = off.getContext('2d');
  for (const cv of cvs) c.drawImage(cv, 0, 0);
  return c.getImageData(0, 0, off.width, off.height);
}
// install once per page load, evaluable from both helpers below
const INSTALL_GRAB = `window.__grabComposite = ${grabComposite.toString()}; true;`;

/** Store the current canvas under `key` for a later {@link canvasDiff}. */
export async function snapshotCanvas(page, key = 'base') {
  await page.evaluate(INSTALL_GRAB);
  await page.evaluate(async (k) => {
    await window.settle();
    window.__snaps = window.__snaps || {};
    window.__snaps[k] = window.__grabComposite();
  }, key);
}

/**
 * Fraction of pixels that changed since the snapshot taken under `key`.
 * @returns {Promise<{ratio: number, sizeChanged: boolean}>}
 */
export function canvasDiff(page, key = 'base', tol = 3, band = null) {
  return page.evaluate(
    async ([k, t, band]) => {
      await window.settle();
      const cv = window.chart.shadowRoot.querySelector('canvas');
      const now = window.__grabComposite();
      const was = (window.__snaps || {})[k];
      if (!was) throw new Error('no canvas snapshot named ' + k);
      if (was.width !== now.width || was.height !== now.height) {
        return { ratio: 1, sizeChanged: true };
      }
      // Optional horizontal band (CSS px, converted to device px) so a spec
      // can ask "did the time axis change without the plot changing?".
      const dpr = now.height / cv.getBoundingClientRect().height;
      const yFrom = band ? Math.max(0, Math.floor(band.y0 * dpr)) : 0;
      const yTo = band ? Math.min(now.height, Math.ceil(band.y1 * dpr)) : now.height;
      let changed = 0;
      let counted = 0;
      for (let i = yFrom * now.width * 4; i < yTo * now.width * 4; i += 4) {
        counted++;
        if (
          Math.abs(now.data[i] - was.data[i]) > t ||
          Math.abs(now.data[i + 1] - was.data[i + 1]) > t ||
          Math.abs(now.data[i + 2] - was.data[i + 2]) > t
        ) {
          changed++;
        }
      }
      return { ratio: counted ? changed / counted : 0, sizeChanged: false };
    },
    [key, tol, band]
  );
}

/**
 * Wait until the canvas stops changing, then snapshot it under `key`. The
 * first paint can be followed by a ResizeObserver-driven repaint a frame or
 * two later, so a baseline grabbed the instant the fixture reports ready is
 * not always the settled picture.
 */
export async function snapshotSettledCanvas(page, key = 'base', tries = 20) {
  await snapshotCanvas(page, '__settling');
  for (let i = 0; i < tries; i++) {
    const { ratio } = await canvasDiff(page, '__settling');
    if (ratio === 0) return snapshotCanvas(page, key);
    await snapshotCanvas(page, '__settling');
  }
  throw new Error('canvas never stopped repainting');
}

/**
 * Assert nothing on the chart moved since the snapshot.
 *
 * `maxRatio` is not slack for "close enough" — it is the antialiasing floor.
 * Repainting the same state can land candle edges on a sub-pixel offset,
 * which recolours a scattering of edge pixels (~0.03% of the canvas) without
 * moving a single mark. Anything the eye would notice — a crosshair, a new
 * candle, a shifted axis — moves 1% of the canvas or more, two orders of
 * magnitude above this.
 */
export async function expectCanvasUnchanged(page, key = 'base', maxRatio = 0.001, band = null) {
  const { ratio, sizeChanged } = await canvasDiff(page, key, 3, band);
  expect(sizeChanged, 'canvas size should not have changed').toBe(false);
  expect(ratio).toBeLessThanOrEqual(maxRatio);
}

/** Assert the picture changed by at least `minRatio` of its pixels. */
export async function expectCanvasChanged(page, key = 'base', minRatio = 0.005, band = null) {
  const { ratio } = await canvasDiff(page, key, 3, band);
  expect(ratio).toBeGreaterThan(minRatio);
}
