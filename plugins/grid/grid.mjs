/**
 * wickchart-grid — multi-chart layout + sync as a wickchart plugin: one
 * element wraps N charts in a CSS grid and keeps their visible ranges and
 * crosshairs in step, entirely through public APIs (`wick:range` /
 * `wick:crosshair` events, setVisibleRange, the layer API). Zero core
 * changes; everything detaches cleanly.
 *
 *   <script type="module" src="./plugins/grid/grid.mjs"></script>
 *
 *   <wick-grid cols="2" gap="10" sync="range crosshair">
 *     <wick-chart label="BTC · 1h"></wick-chart>
 *     <wick-chart label="BTC · 15m" indicators="rsi:14"></wick-chart>
 *   </wick-grid>
 *
 * The host needs a height (grids size rows from it):
 *   wick-grid { display: grid } is applied by the element; give it
 *   `height: 600px` or a flex/grid parent. Attributes: cols (default 2,
 *   clamped 1..8), gap (px, default 10, clamped 0..64), sync (space/comma
 *   list of `range` | `crosshair` | `time` | `both`; default both).
 *
 * Programmatic use on charts you already lay out yourself:
 *   import { attachGrid } from 'wickchart-grid';
 *   const grid = attachGrid([a, b, c], { sync: 'range time' });
 *   grid.detach();
 *
 * The pure fan-out logic (echo/clamp-cycle guards, ghost crosshair) lives in
 * wickchart-grid/core.
 */

import { GridSync, makeGhost, parseSync, attachGrid, SYNC_KINDS } from './core.mjs';

export { GridSync, makeGhost, parseSync, attachGrid, SYNC_KINDS };

const HTMLElementBase = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

const intAttr = (el, name, fallback, lo, hi) => {
  const v = parseInt(el.getAttribute(name) || '', 10);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
};

class WickGrid extends HTMLElementBase {
  static get observedAttributes() {
    return ['cols', 'gap', 'sync'];
  }

  constructor() {
    super();
    this._sync = null;
    this._mo = null;
  }

  connectedCallback() {
    this._applyLayout();
    if (!this._sync) this._sync = new GridSync({ sync: this.getAttribute('sync') });
    // charts may arrive (or be removed) after the grid connects — feeds and
    // framework bindings do exactly that — so watch the light-DOM children
    this._mo = new MutationObserver(() => this._syncChildren());
    this._mo.observe(this, { childList: true, subtree: true });
    this._syncChildren();
  }

  disconnectedCallback() {
    if (this._mo) {
      this._mo.disconnect();
      this._mo = null;
    }
    if (this._sync) this._sync.detach();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal) return;
    if (name === 'sync') {
      if (this._sync) this._sync.kinds = parseSync(newVal);
    } else {
      this._applyLayout();
    }
  }

  /** The charts currently in the group (insertion order). */
  get charts() {
    return this._sync ? this._sync.charts() : [];
  }

  _applyLayout() {
    const cols = intAttr(this, 'cols', 2, 1, 8);
    const gap = intAttr(this, 'gap', 10, 0, 64);
    this.style.display = 'grid';
    this.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    this.style.gridAutoRows = 'minmax(0, 1fr)';
    this.style.gap = `${gap}px`;
  }

  _syncChildren() {
    const kids = new Set(
      [...this.children].filter(
        (el) => el.tagName === 'WICK-CHART' || el.tagName === 'HAB-CHART'
      )
    );
    for (const c of this._sync.charts()) {
      if (!kids.has(c)) this._sync.remove(c);
    }
    for (const c of kids) this._sync.add(c);
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('wick-grid')) {
  customElements.define('wick-grid', WickGrid);
}

export default WickGrid;
export { WickGrid };
