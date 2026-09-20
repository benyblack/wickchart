/* ==========================================================================
 * Min/max downsampling at deep zoom — the line/area path keeps every
 * intracolumn close extreme (buildColumns cMin/cMax), so a one-bar spike
 * stays visible and inside the autoscale even when a pixel column holds
 * dozens of bars. Candles already preserved extremes via high/low.
 * ========================================================================== */
import { test, expect } from '@playwright/test';
import { openFixture } from './helpers.mjs';

test('a one-bar spike survives deep zoom-out on a line chart', async ({ page }) => {
  await openFixture(page, '?empty');
  const spikeClose = await page.evaluate(async () => {
    const t0 = Date.UTC(2024, 0, 2);
    const bars = [];
    let p = 100;
    for (let i = 0; i < 4000; i++) {
      p *= 1 + Math.sin(i / 11) * 0.001;
      // one bar closes far above everything around it
      const spike = i === 2000 ? 40 : 0;
      const close = p + spike;
      bars.push({ time: t0 + i * 60_000, open: p, high: close, low: p, close, volume: 1 });
    }
    window.chart.setData(bars);
    window.chart.setAttribute('type', 'line');
    await window.settle(); // let the pending _needsFit land first
    // whole 4000-bar history across ~850px → spacing ~0.2px: the
    // pixel-column aggregation path is on
    window.chart.setVisibleRange({ from: bars[0].time, to: bars.at(-1).time });
    return bars[2000].close;
  });
  await page.evaluate(() => window.settle());

  const res = await page.evaluate(() => {
    const chart = window.chart;
    const ly = chart._ly;
    const colMode = chart._view.spacing < 0.7;
    const s = chart._lastScale;
    // the spike must be inside the settled scale (it set the visible max)
    return {
      colMode,
      spacing: chart._view.spacing,
      rawHi: s.rawHi,
      spikeInView: s.rawHi >= 140,
      plotRight: ly.plotRight,
    };
  });
  expect(res.colMode).toBe(true); // actually in the aggregated path
  expect(res.spikeInView).toBe(true); // scale includes the spike extreme

  // and the polyline physically reaches it: the accent stroke passes
  // within a few px of the spike's (x, y) under the current scale
  const strokeAtSpike = await page.evaluate((spikeClose) => {
    const chart = window.chart;
    const cvs = chart.shadowRoot.querySelectorAll('canvas');
    const off = document.createElement('canvas');
    off.width = cvs[0].width;
    off.height = cvs[0].height;
    const c = off.getContext('2d');
    for (const cv of cvs) c.drawImage(cv, 0, 0);
    const dpr = off.width / chart.getBoundingClientRect().width;
    const { data } = c.getImageData(0, 0, off.width, off.height);
    const ly = chart._ly;
    const s = chart._lastScale;
    const x = Math.round(chart._xFor(2000) * dpr); // spike bar, mid-history
    const y = Math.round(
      (ly.main.y0 + ((s.max - spikeClose) / (s.max - s.min)) * ly.main.h) * dpr
    );
    const R = 12; // search radius in device px
    for (let yy = Math.max(0, y - R); yy <= Math.min(off.height - 1, y + R); yy++) {
      for (let xx = Math.max(0, x - R); xx <= Math.min(off.width - 1, x + R); xx++) {
        const i = (yy * off.width + xx) * 4;
        // the dark-theme accent is a saturated blue against a near-black bg
        if (data[i + 2] > 150 && data[i + 2] > data[i] + 60) return true;
      }
    }
    return false;
  }, await page.evaluate(() => window.chart.data[2000].close));
  expect(strokeAtSpike).toBe(true);
});
