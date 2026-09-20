/* ==========================================================================
 * i18n string packs + the preset attribute, end to end on a live element:
 * a German chart's chrome reads German, a French host pack registers and
 * applies, and preset=minimal strips the chrome without touching explicit
 * attributes.
 * ========================================================================== */
import { test, expect } from '@playwright/test';
import { openFixture } from './helpers.mjs';

test('lang=de localizes the empty state, stats chip and aria label', async ({ page }) => {
  await openFixture(page, '?empty');
  await page.evaluate(() => {
    window.chart.setAttribute('lang', 'de');
    window.chart.setAttribute('stats', '');
    const t0 = Date.UTC(2024, 0, 2);
    window.chart.setData(
      Array.from({ length: 60 }, (_, i) => ({
        time: t0 + i * 60_000, open: 10, high: 11, low: 9, close: 10 + (i % 5), volume: 100,
      }))
    );
  });
  await page.evaluate(() => window.settle());
  const de = await page.evaluate(() => ({
    stats: document.querySelector('#chart').shadowRoot.querySelector('.statsrow').textContent,
    aria: document.querySelector('#chart').shadowRoot.querySelector('canvas').getAttribute('aria-label'),
  }));
  expect(de.stats).toContain('MaxDD');
  expect(de.stats).toContain('Vol.p.a.');
  expect(de.stats).toContain('auf');
  expect(de.aria).toContain('Kerzen');
  expect(de.aria).not.toContain('bars');
});

test('an empty German chart says Keine Daten', async ({ page }) => {
  await openFixture(page, '?empty');
  await page.evaluate(() => window.chart.setAttribute('lang', 'de'));
  await page.evaluate(() => window.settle());
  const txt = await page.evaluate(
    () => document.querySelector('#chart').shadowRoot.querySelector('.nodata').textContent
  );
  expect(txt).toContain('Keine Daten');
});

test('a host-registered French pack applies with English fallback', async ({ page }) => {
  await openFixture(page, '?empty');
  // the fixture imports the module; register through the element's constructor
  await page.evaluate(() => {
    const ctor = Object.getPrototypeOf(window.chart).constructor;
    ctor.registerStrings('fr', { noData: 'Aucune donnée' });
    window.chart.setAttribute('lang', 'fr');
  });
  await page.evaluate(() => window.settle());
  const txt = await page.evaluate(
    () => document.querySelector('#chart').shadowRoot.querySelector('.nodata').textContent
  );
  expect(txt).toContain('Aucune donnée');
});

test('preset=minimal strips the chrome; explicit attributes still win', async ({ page }) => {
  await openFixture(page, '?empty');
  const ly = await page.evaluate(() => {
    const t0 = Date.UTC(2024, 0, 2);
    window.chart.setData(
      Array.from({ length: 60 }, (_, i) => ({
        time: t0 + i * 60_000, open: 10, high: 11, low: 9, close: 10 + (i % 5), volume: 100,
      }))
    );
    window.chart.setAttribute('preset', 'minimal');
    return null;
  });
  void ly;
  await page.evaluate(() => window.settle());
  const minimal = await page.evaluate(() => ({
    volumeOn: window.chart._ind.volume,
    legendVisible:
      document.querySelector('#chart').shadowRoot.querySelector('.legend').style.display !== 'none',
    statsOn: window.chart._stats,
  }));
  expect(minimal.volumeOn).toBe(false); // no inline volume histogram
  expect(minimal.legendVisible).toBe(false);
  expect(minimal.statsOn).toBe(false);

  // an explicit indicators token survives the preset
  await page.evaluate(() => window.chart.setAttribute('indicators', 'volume'));
  await page.evaluate(() => window.settle());
  expect(await page.evaluate(() => window.chart._ind.volume)).toBe(true);
});

test('preset=pro turns the dense chrome on', async ({ page }) => {
  await openFixture(page, '?empty');
  await page.evaluate(() => {
    const t0 = Date.UTC(2024, 0, 2);
    window.chart.setData(
      Array.from({ length: 60 }, (_, i) => ({
        time: t0 + i * 60_000, open: 10, high: 11, low: 9, close: 10 + (i % 5), volume: 100,
      }))
    );
    window.chart.setAttribute('preset', 'pro');
  });
  await page.evaluate(() => window.settle());
  const pro = await page.evaluate(() => ({
    volumeOn: window.chart._ind.volume,
    statsOn: window.chart._stats,
    legendVisible:
      document.querySelector('#chart').shadowRoot.querySelector('.legend').style.display !== 'none',
  }));
  expect(pro.volumeOn).toBe(true); // inline volume histogram on
  expect(pro.statsOn).toBe(true);
  expect(pro.legendVisible).toBe(true);
});
