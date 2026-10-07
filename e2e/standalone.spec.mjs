/* ==========================================================================
 * Standalone export — the browser-only half: exportChart() fetching the
 * real module files, the produced .html opening OFFLINE from file:// (zero
 * subresource requests, painted canvas, same visible range), and the
 * drag-and-drop adoption back into a live chart. The pure half (flattening,
 * payload, builder, regex parse) is covered by tests/standalone.test.mjs.
 * ========================================================================== */
import { test, expect } from '@playwright/test';
import { openFixture } from './helpers.mjs';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('an exported chart opens offline from file:// with zero requests and the same view', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openFixture(page);

  const before = await page.evaluate(async () => {
    const { exportChart } = await import('/src/standalone.js');
    const html = await exportChart(window.chart, { title: 'e2e standalone', source: 'e2e' });
    return { html, range: window.chart.getVisibleRange(), bars: window.chart.data.length };
  });

  const dir = mkdtempSync(join(tmpdir(), 'wick-standalone-'));
  const file = join(dir, 'chart.html');
  writeFileSync(file, before.html);

  // every request the offline page makes — the document itself excluded —
  // gets recorded; a self-contained file must issue none
  const requests = [];
  page.on('request', (r) => {
    if (r.resourceType() !== 'document') requests.push(r.url());
  });

  await page.goto('file://' + file);

  const after = await page.evaluate(async () => {
    const c = document.querySelector('wick-chart');
    await new Promise(requestAnimationFrame);
    return {
      upgraded: !!c.getVisibleRange,
      label: c.getAttribute('label'),
      bars: c.data.length,
      range: c.getVisibleRange(),
      inkedPixels: (() => {
        const cv = c.shadowRoot.querySelector('canvas');
        const { data } = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
        let base = null, inked = 0;
        for (let i = 0; i < data.length; i += 16) {
          const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
          if (base === null) base = key;
          else if (key !== base) inked++;
        }
        return inked;
      })(),
    };
  });

  expect(after.upgraded).toBe(true);
  expect(after.label).toBe('e2e standalone');
  expect(after.bars).toBe(before.bars);
  expect(after.range.from).toBe(before.range.from);
  expect(after.range.to).toBe(before.range.to);
  expect(after.inkedPixels).toBeGreaterThan(1000);
  expect(requests, 'the standalone file must not fetch anything').toEqual([]);
  expect(errors).toEqual([]);

  rmSync(dir, { recursive: true, force: true });
});

test('a dropped shared file restores into a live chart', async ({ page }) => {
  await openFixture(page);

  // export with a capped history so adoption is observable as a data change
  const html = await page.evaluate(async () => {
    const { exportChart } = await import('/src/standalone.js');
    return exportChart(window.chart, { title: 'dropped chart', maxBars: 120 });
  });

  const adopted = await page.evaluate(async (htmlText) => {
    const { attachDrop } = await import('/src/standalone.js');
    window.__adopted = null;
    window.__detach = attachDrop(window.chart, {
      onadopt: (p) => { window.__adopted = { n: p.bars.length, label: p.label }; },
    });
    const dt = new DataTransfer();
    dt.items.add(new File([htmlText], 'shared.html', { type: 'text/html' }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    window.__detach();
    return {
      adopted: window.__adopted,
      bars: window.chart.data.length,
      label: window.chart.getAttribute('label'),
    };
  }, html);

  expect(adopted.adopted).toEqual({ n: 120, label: 'dropped chart' });
  expect(adopted.bars).toBe(120);
  expect(adopted.label).toBe('dropped chart');
});
