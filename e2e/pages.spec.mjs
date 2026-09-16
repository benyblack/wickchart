/* ==========================================================================
 * The shipped pages at phone width.
 *
 * Every page already declared `width=device-width`, which is what makes this
 * worth a test: when the content cannot fit, the browser does not show a
 * horizontal scrollbar — it widens the layout viewport and renders the whole
 * page zoomed out. docs.html laid itself out 946px wide on a 412px phone and
 * looked merely small, not broken, which is exactly why it survived.
 *
 * Two things are asserted per page: the document does not exceed the
 * viewport, and nothing wider than the viewport is stranded inside a
 * container that cannot scroll to reveal it.
 * ========================================================================== */
import { test, expect } from '@playwright/test';

const PAGES = [
  '/index.html',
  '/docs.html',
  '/plugins.html',
  '/demo/index.html',
  '/demo/react.html',
  '/demo/declarative.html',
  '/demo/worker.html',
];

const PHONE = { width: 412, height: 915 };

test.describe('phone layout', () => {
  test.use({ viewport: PHONE });

  test.beforeEach(async ({ page }) => {
    // Hermetic: no web fonts, no CDN modules, no exchange websockets. System
    // fallback fonts are generally wider than Inter, so a layout that holds
    // here holds with the real fonts too.
    await page.route('**/*', (route) => {
      const url = route.request().url();
      return url.startsWith('http://127.0.0.1') ? route.continue() : route.abort();
    });
  });

  for (const path of PAGES) {
    test(`${path} fits a 412px screen`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('domcontentloaded');
      // Let fallback fonts and any chart layout settle.
      await page.waitForTimeout(600);

      const report = await page.evaluate(() => {
        const W = window.innerWidth;
        const stranded = [];
        for (const el of document.querySelectorAll('body *')) {
          const box = el.getBoundingClientRect();
          if (box.height === 0 || box.width <= W + 1) continue;
          // Walk up: something must be able to scroll this into view.
          let parent = el.parentElement;
          let reachable = false;
          while (parent && parent !== document.body) {
            const overflowX = getComputedStyle(parent).overflowX;
            if (overflowX === 'auto' || overflowX === 'scroll') {
              reachable = true;
              break;
            }
            if (overflowX === 'hidden') break;
            parent = parent.parentElement;
          }
          if (!reachable) {
            const cls = String(el.className || '').split(' ')[0];
            stranded.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} (${Math.round(box.width)}px)`);
          }
        }
        return {
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: W,
          stranded: [...new Set(stranded)],
        };
      });

      expect(
        report.scrollWidth,
        `page lays out ${report.scrollWidth}px wide on a ${report.innerWidth}px screen, so it renders zoomed out`
      ).toBeLessThanOrEqual(report.innerWidth + 1);

      expect(report.stranded, 'content wider than the screen that nothing can scroll to').toEqual([]);
    });
  }

  for (const path of ['/index.html', '/docs.html', '/plugins.html']) {
    test(`${path} has finger-sized nav links`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(400);

      // The top nav only — the docs sidebar is a long list read by scrolling,
      // not a row of targets competing for the same thumb.
      const small = await page.evaluate(() => {
        const links = document.querySelectorAll('body > nav a, .topbar nav a');
        const out = [];
        for (const a of links) {
          const box = a.getBoundingClientRect();
          if (box.height === 0) continue;
          if (box.height < 32) out.push(`${a.textContent.trim()} ${Math.round(box.width)}x${Math.round(box.height)}`);
        }
        return { checked: links.length, small: out };
      });

      expect(small.checked, 'no nav links found — has the markup changed?').toBeGreaterThan(2);
      expect(small.small, 'nav links shorter than a fingertip').toEqual([]);
    });
  }
});
