/* Ichimoku: the one built-in whose series run past the last bar. The senkou
 * spans are forward-displaced, so this spec pins the two renderer mechanics
 * the node suite can't see: the kumo fill painting between the spans, and
 * the projected tail drawing into the future band right of the last bar. */
import { test, expect } from '@playwright/test';
import { openFixture } from './helpers.mjs';

/**
 * Inked sampled pixels in the band between the last bar and the price axis
 * — where only forward-displaced series can draw. Compared against the
 * bare-chart noise floor (gridlines), not against zero. Runs in the page;
 * installed as a string so `page.evaluate` can reach it.
 */
function futureBandInk() {
  const c = window.chart;
  const ly = c._ly;
  const lastX = c._xFor(c._data.length - 1);
  const cv = c.shadowRoot.querySelector('canvas');
  const dpr = cv.width / cv.getBoundingClientRect().width;
  const xs = Math.round((lastX + 2) * dpr);
  const xe = Math.round(ly.plotRight * dpr);
  const { data } = cv.getContext('2d').getImageData(xs, 0, Math.max(1, xe - xs), cv.height);
  let base = null;
  let inked = 0;
  for (let i = 0; i < data.length; i += 16) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (base === null) base = key;
    else if (key !== base) inked++;
  }
  return inked;
}

test('senkou spans project into the future band', async ({ page }) => {
  await openFixture(page, '?empty');
  const out = await page.evaluate(async (install) => {
    eval(install); // window.__futureBandInk
    const c = window.chart;
    c.setAttribute('auto', 'false'); // the projection needs the view held open
    c.setData(window.makeBars());
    await window.settle();
    const probe = () => window.__futureBandInk();
    const bare = probe(); // candles only — gridlines are the noise floor
    c.setAttribute('indicators', 'ichimoku');
    await window.settle();
    const margin = probe(); // default right margin shows the first few bars
    c._view.rightIndex = c._data.length - 1 + 28; // reveal all 26 + slack
    c._render();
    await window.settle();
    return { bare, margin, full: probe() };
  }, `window.__futureBandInk = ${futureBandInk.toString()}; true;`);
  // the projected cloud paints: above the noise floor, and more of it as
  // more future space comes into view
  expect(out.margin).toBeGreaterThan(out.bare * 1.5);
  expect(out.full).toBeGreaterThan(out.margin);
});

test('five lines + fill come back from the compute path', async ({ page }) => {
  await openFixture(page, '?empty');
  const out = await page.evaluate(async () => {
    const c = window.chart;
    c.setAttribute('indicators', 'ichimoku');
    c.setData(window.makeBars());
    await window.settle();
    const res = c._indicatorSeries(c._ind.overlays[0]);
    return {
      names: res.lines.map((l) => l.name),
      hasFill: !!(res.fill && Array.isArray(res.fill.a) && Array.isArray(res.fill.b)),
      senkouLen: res.lines[2].values.length,
      dataLen: c._data.length,
    };
  });
  expect(out.names).toEqual(['tenkan', 'kijun', 'senkouA', 'senkouB', 'chikou']);
  expect(out.hasFill).toBe(true);
  expect(out.senkouLen).toBe(out.dataLen + 26); // forward displacement
});
