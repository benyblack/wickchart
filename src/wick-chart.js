/* ==========================================================================
 * <wick-chart> — a modern, dependency-free financial charting web component.
 *
 *   <wick-chart label="BTC · 1h" type="candles" indicators="sma:20 volume">
 *   </wick-chart>
 *   <script type="module">
 *     const chart = document.querySelector('wick-chart');
 *     chart.setData(bars);      // [{ time, open, high, low, close, volume }]
 *     chart.update(bar);        // streaming update / append
 *   </script>
 *
 * Zero dependencies. Canvas-rendered. Framework-agnostic (works in React,
 * Vue, plain HTML). Themeable with --wick-* CSS custom properties.
 *
 * The 0.x names (<hab-chart>, --hab-*, hab:* events) still work as
 * deprecated aliases — see the README migration notes.
 *
 * MIT License.
 * ========================================================================== */

import {
  clamp, isNum, numberFmt, fmtCompact, autoPrecision, niceStep, hexToRgba,
  FONT_STACK, axisFont, pillFont, roundRectPath,
  TIME_STEPS, HOUR, DAY, toMs, zoneOffset, hhmm, fmtDay, fmtMonth, fmtYear, fmtFull,
  THEMES, mergeOlderData, detectGaps,
  parseIndicators, normalizeIndicatorResult, BUILTIN_INDICATORS,
  positionPnl, positionPnlPct, checkAlertCross, computeStats, safeColor,
  SERIES_TYPES, calcHeikinAshi, buildColumns, computeVolumeProfile,
  calcRSI, detectAnnotations, priceToFreq,
  calcRealizedVol, volRegimeBands, percentileOfSorted, parseVolShading,
  windowSummary, normalizeOverlays, barIndexForTime, resolveOverlayColor,
  compileScript, predicateTrueSeries, scriptAlertStep,
  AI_TOOLS, aiPromptText, applyChartOps,
  calcVolCone, normalizeScenario, normalizeRiskPlan, PresenceTracker,
  narrateWindow, brushStats,
  easeInOutCubic, sceneList, warnDeprecatedAlias,
} from './core.js';

/* ------------------------------------------------------------------ *
 * <wick-chart>
 * ------------------------------------------------------------------ */

/** Indicator registry — module scope so registrations are shared by
 *  <wick-chart> and the deprecated <hab-chart> alias element. */
const REGISTRY = new Map(BUILTIN_INDICATORS);

/** Bars from which the worker compute path engages — below it, sync wins
 *  (posting the epoch snapshot costs more than the compute it saves). */
const WORKER_MIN_BARS = 50000;
/** Returned while an off-thread compute is in flight: no lines yet, and —
 *  like a failed compute — every renderer draws nothing. */
const PENDING_SERIES = { lines: [], histogram: null };
/**
 * Built-ins a streamed tick can update by recomputing a bounded tail with
 * the SAME batch definition (window indicators exactly, recursive ones
 * converge geometrically). Excluded: obv/vwap are cumulative over all
 * history, supertrend is a path-dependent state machine — no tail can
 * patch those; they keep the full-recompute behavior.
 */
const ONLINE_SKIP = new Set(['obv', 'vwap', 'supertrend']);
/** Tail warm-up bars per tick: past the recursion decay of any realistic
 *  period (~10×), and still ~0.1 ms of work per indicator. */
const ONLINE_WARMUP = 400;
/** Per-chart worker session ids (see _workerCompute / src/worker-core.js). */
let CHART_SID = 0;

  /* SSR safety: importing this module under Node (Next.js/Nuxt server render)
 * must not throw — the element simply registers only in browsers. */
const HTMLElementBase = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

class WickChart extends HTMLElementBase {
    static get observedAttributes() {
      return ['theme', 'type', 'log', 'auto', 'indicators', 'precision', 'label', 'stats', 'profile', 'annotations', 'volshading', 'overlays', 'co-view', 'co-view-name', 'brush', 'sonify', 'alert-evaluate', 'timezone', 'vwap-anchor', 'worker'];
    }

    /**
     * Shared ChartWorkerPool for the worker compute path (set by importing
     * 'wickchart/worker'; null — everything sync — until then).
     * @type {object|null}
     */
    static _workerPool = null;

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          :host {
            display: block;
            position: relative;
            width: 100%;
            height: 100%;
            min-height: 220px;
            contain: content;
            /* the overlays lay themselves out against the chart's own width
               (see the @container rule at the end of this sheet) */
            container-type: inline-size;
          }
          :host(:focus-visible) {
            outline: 2px solid var(--wick-accent, var(--hab-accent, #4c8dff));
            outline-offset: -2px;
          }
          .wrap { position: absolute; inset: 0; overflow: hidden; }
          canvas {
            position: absolute; inset: 0;
            width: 100%; height: 100%;
            display: block;
            /* pan-y, not none: a vertical swipe belongs to the page, or a
               chart embedded in a phone article becomes a dead zone the
               reader cannot scroll past. Horizontal drags and pinches still
               arrive as pointer events; _onTouchMove takes the gesture back
               (preventDefault) once the chart owns it. */
            touch-action: pan-y;
            cursor: crosshair;
            user-select: none;
            -webkit-user-select: none;
            /* long-press is the scrub gesture — suppress the iOS callout */
            -webkit-touch-callout: none;
          }
          canvas.grabbing { cursor: grabbing; }
          .legend {
            position: absolute; left: 10px; top: 8px; z-index: 2;
            pointer-events: none;
            font: 500 12px/1.7 ${FONT_STACK};
            letter-spacing: 0.01em;
            max-width: calc(100% - 24px);
          }
          .legend .row { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
          .legend .sym {
            color: var(--wick-text-strong, var(--hab-text-strong, #e6edf3));
            font-weight: 700;
            font-size: 13px;
            letter-spacing: 0.02em;
          }
          .legend .kv { display: inline-flex; gap: 5px; align-items: baseline; white-space: nowrap; }
          .legend .k { color: var(--wick-text, var(--hab-text, #8b949e)); font-size: 11px; }
          .legend .v { color: var(--wick-text-strong, var(--hab-text-strong, #e6edf3)); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
          .legend .pct { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
          .legend .up { color: var(--wick-up, var(--hab-up, #16c784)); }
          .legend .dn { color: var(--wick-down, var(--hab-down, #ea3943)); }
          .legend .ind {
            display: inline-flex; align-items: center; gap: 6px;
            color: var(--wick-text, var(--hab-text, #8b949e)); font-size: 11.5px; white-space: nowrap;
          }
          .legend .ind i { width: 8px; height: 2.5px; border-radius: 2px; display: inline-block; }
          .legend .ind .v { font-size: 12px; }
          .legend .insight {
            color: var(--wick-accent, var(--hab-accent, #4c8dff));
            background: var(--wick-chip, var(--hab-chip, rgba(127, 137, 153, 0.12)));
            border-radius: 6px;
            padding: 1px 8px;
            font-size: 11.5px;
            font-weight: 600;
          }
          .nodata {
            position: absolute; inset: 0;
            display: flex; align-items: center; justify-content: center;
            color: var(--wick-text, var(--hab-text, #8b949e));
            font: 500 13px ${FONT_STACK};
            pointer-events: none;
          }
          .nodata[hidden] { display: none; }
          .hud {
            position: absolute; right: 10px; top: 8px; z-index: 2;
            display: flex; flex-direction: column; gap: 4px; align-items: flex-end;
            pointer-events: none;
            font: 600 11.5px/1.4 ${FONT_STACK};
          }
          .hud .pos {
            display: inline-flex; gap: 9px; align-items: baseline; white-space: nowrap;
            background: var(--wick-chip, var(--hab-chip, rgba(127, 137, 153, 0.12)));
            border: 1px solid var(--wick-border, var(--hab-border, rgba(148, 163, 184, 0.2)));
            border-radius: 7px;
            padding: 3px 9px;
          }
          .hud .statsrow {
            display: inline-flex; gap: 12px; white-space: nowrap;
            background: var(--wick-chip, var(--hab-chip, rgba(127, 137, 153, 0.12)));
            border: 1px solid var(--wick-border, var(--hab-border, rgba(148, 163, 184, 0.2)));
            border-radius: 7px;
            padding: 3px 10px;
            color: var(--wick-text, var(--hab-text, #8b949e));
            font-variant-numeric: tabular-nums;
          }
          .hud .statsrow b { color: var(--wick-text-strong, var(--hab-text-strong, #e6edf3)); font-weight: 600; }
          .hud .k { color: var(--wick-text, var(--hab-text, #8b949e)); font-weight: 500; }
          .hud .v { color: var(--wick-text-strong, var(--hab-text-strong, #e6edf3)); font-variant-numeric: tabular-nums; }
          .hud .up { color: var(--wick-up, var(--hab-up, #16c784)); }
          .hud .dn { color: var(--wick-down, var(--hab-down, #ea3943)); }

          /* Narrow charts: the legend (top-left) and the HUD (top-right) are
             both pinned to the top, so on a phone they land on top of each
             other — a label plus a few indicators wraps the legend to three
             rows and the stats row draws straight through it. Below 560px
             they stack instead.

             A container query, not a media query: what matters is how wide
             the chart is, not the screen. A narrow chart in a sidebar on a
             desktop has exactly the same problem.

             They become position:relative rather than static so they stay in
             flow *and* keep their stacking context — an unpositioned box would
             paint underneath the absolutely positioned canvas. The canvas is
             out of flow either way, so the flex column never moves it. */
          @container (max-width: 560px) {
            .wrap { display: flex; flex-direction: column; align-items: flex-start; }
            .legend, .hud {
              position: relative;
              left: auto; right: auto; top: auto;
              max-width: calc(100% - 20px);
            }
            .legend { margin: 8px 10px 0; }
            .hud { margin: 4px 10px 0; align-items: flex-start; }
            .hud .pos, .hud .statsrow { white-space: normal; }
          }
        </style>
        <div class="wrap" part="wrap">
          <canvas part="canvas" role="img"></canvas>
          <div class="legend" part="legend" aria-hidden="true"></div>
          <div class="hud" part="hud" aria-hidden="true">
            <div class="poss"></div>
            <div class="statsrow"></div>
          </div>
          <div class="nodata" hidden>No data</div>
        </div>`;

      this._canvas = root.querySelector('canvas');
      this._ctx = this._canvas.getContext('2d');
      this._legend = root.querySelector('.legend');
      this._hud = root.querySelector('.hud');
      this._poss = root.querySelector('.poss');
      this._statsRow = root.querySelector('.statsrow');
      this._nodata = root.querySelector('.nodata');

      this._data = [];
      this._version = 0;
      this._view = { rightIndex: 10, spacing: 8 };
      this._auto = true;
      this._needsFit = true;
      this._hover = null; // { index, x, y }
      this._dt = HOUR; // median bar interval (ms)
      this._ly = null; // last layout
      this._cache = { v: -1, map: {} };
      this._pal = null; // palette cache
      this._palKey = '';
      this._legendKey = '';
      this._raf = 0;
      this._connected = false;

      // defaults; attributes (if present) override via attributeChangedCallback
      this._theme = 'dark';
      this._type = 'candles';
      this._log = false;
      this._precision = null;
      this._label = '';
      this._stats = false;
      this._statsKey = '';
      this._profile = false;
      this._profileKey = '';
      this._profileRes = null;
      this._annotations = false;
      this._annoKey = '';
      this._annoList = null;
      this._volshade = null;

      // cross-tab co-view state
      this._coviewName = null;
      this._coviewCh = null;
      this._coviewPeer = '';
      this._coviewLast = 0;
      this._ghost = null;
      this._ghostTimer = 0;
      // presence: peer viewports (who is looking where)
      this._coviewLabel = null; // display name from the co-view-name attribute
      this._presence = new PresenceTracker();
      this._coviewBeat = 0;
      this._coviewViewLast = 0;

      // sonification state
      this._sonify = false;
      this._actx = null;
      this._lastToneIdx = -1;
      this._playToken = 0;
      this._measure = null; // { iA, pA, iB, pB, done }
      this._measuring = false;
      // bar-walk narrator state
      this._walkTimer = 0;
      // story mode state: token cancels stale async runs
      this._storyToken = 0;
      this._story = null;
      // delta brush state: mode flag + current/finished selection
      this._brush = false;
      this._brushSel = null; // { i0, i1, stats } — the committed selection
      this._brushDrag = null; // { i0, i1 } — while the pointer is down
      this._ind = { overlays: [], panes: [], volume: true };

      // worker compute path (see _indicatorSeries): built-in indicators over
      // big histories compute off the main thread. Results are cached per
      // data *epoch* (bulk loads: setData/clearData/backfill) — streamed
      // ticks bump _version, not _epoch, so they stop recomputing the full
      // series per bar; the forming bar's value catches up on the next load.
      this._workerOn = false;
      this._epoch = 0;
      this._workerCache = { epoch: -1, map: {}, pending: {}, sent: -1 };
      this._sid = ++CHART_SID;
      // incremental tick updates: { epoch, map: key → { v, res } } — the
      // freshest series per key, patched in place by _onlineTick
      this._onlineSeries = { epoch: -1, map: {} };

      this._pointers = new Map();
      this._pan = null;
      this._pinch = null;
      // long-press scrub: touch has no hover, so reading a bar needs a
      // gesture of its own (see _armPress)
      this._scrub = false;
      this._pressTimer = 0;
      this._pressOrigin = null;

      // plugin layers: external draw hooks + pointer claims (see addLayer)
      this._layers = [];
      this._layerClaim = null; // { layer, pointerId } while a layer owns a drag
      this._layerSeq = 0;

      // history backfill state (onloadmore declared as a class field above)
      this._loadingMore = false;
      this._noMore = false;

      // trading overlays
      this._positions = [];
      this._alerts = [];
      this._seq = 0;
      // Default evaluation mode for alerts that don't pick one, and the last
      // bar index known to be final — see _lastClosedIndex().
      this._alertEval = 'live';
      this._lastClosedIdx = -1;
      this._tz = 'local';
      this._vwapAnchor = 'utc';

      // server-side overlays (zones & levels)
      this._overlays = [];

      // scenario projection (ghost path + vol cone)
      this._scenario = null;
      // risk plan (R-multiple grid)
      this._riskPlan = null;

      this._onResize = () => this._invalidate();
      this._onPointerDown = (e) => this._pointerDown(e);
      this._onPointerMove = (e) => this._pointerMove(e);
      this._onPointerUp = (e) => this._pointerUp(e);
      this._onPointerLeave = () => {
        if (this._hover) {
          this._hover = null;
          this._emitCrosshair(null);
          this._invalidate();
        }
      };
      this._onWheel = (e) => this._wheel(e);
      this._onDbl = () => {
        this._stopPlayback();
        this.fit();
      };
      this._onKey = (e) => this._keydown(e);
      // The canvas leaves vertical scrolling to the page (touch-action:
      // pan-y). Once a chart gesture owns the touch — a pinch, a scrub, a
      // layer drag, or a pan that has committed to a direction — the
      // gesture is taken back, or the browser would hand it to the scroller
      // halfway through. Must be non-passive to be allowed to.
      this._onTouchMove = (e) => {
        if (
          this._scrub ||
          this._pointers.size >= 2 ||
          this._layerClaim ||
          (this._pan && this._pan.moved)
        ) {
          e.preventDefault();
        }
      };
      // devicePixelRatio changes without the CSS box changing size — dragging
      // the window to a monitor with a different ratio, or a browser zoom
      // that lands on the same layout width. ResizeObserver stays silent for
      // those, so the canvas would keep its old backing store and render
      // soft until something else forced a resize. A `resolution` media
      // query is the only event for it; it only ever matches the ratio it
      // was created with, so each change re-arms a fresh one.
      this._onDprChange = () => {
        this._watchDpr();
        this._invalidate();
      };
    }

    connectedCallback() {
      this._connected = true;
      if (this.tabIndex < 0) this.tabIndex = 0;
      this._ro =
        this._ro ||
        new ResizeObserver(() => {
          if (this._ly) this._invalidate();
          else this._needsFit = true, this._invalidate();
        });
      this._ro.observe(this);

      const cv = this._canvas;
      cv.addEventListener('pointerdown', this._onPointerDown);
      cv.addEventListener('pointermove', this._onPointerMove);
      cv.addEventListener('pointerup', this._onPointerUp);
      cv.addEventListener('pointercancel', this._onPointerUp);
      cv.addEventListener('pointerleave', this._onPointerLeave);
      cv.addEventListener('wheel', this._onWheel, { passive: false });
      cv.addEventListener('touchmove', this._onTouchMove, { passive: false });
      cv.addEventListener('dblclick', this._onDbl);
      this.addEventListener('keydown', this._onKey);

      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => this._invalidate()).catch(() => {});
      }
      if (this._coviewName) this._setupCoView();
      this._watchDpr();
      this._invalidate();
    }

    disconnectedCallback() {
      this._connected = false;
      this.stopWalk(true);
      this.stopStory(true);
      this._layerClaim = null;
      if (this._coviewCh) {
        this._coviewSend({ type: 'bye' });
        try {
          this._coviewCh.close();
        } catch (_) {}
        this._coviewCh = null;
      }
      clearInterval(this._coviewBeat);
      this._coviewBeat = 0;
      if (this._presence && this._presence.peers.size) {
        const left = this._presence.list();
        this._presence = new PresenceTracker();
        this._fire('peers', { peers: [], joined: [], left });
      }
      clearTimeout(this._ghostTimer);
      if (this._ro) this._ro.disconnect();
      this._unwatchDpr();
      const cv = this._canvas;
      cv.removeEventListener('pointerdown', this._onPointerDown);
      cv.removeEventListener('pointermove', this._onPointerMove);
      cv.removeEventListener('pointerup', this._onPointerUp);
      cv.removeEventListener('pointercancel', this._onPointerUp);
      cv.removeEventListener('pointerleave', this._onPointerLeave);
      cv.removeEventListener('wheel', this._onWheel);
      cv.removeEventListener('touchmove', this._onTouchMove);
      cv.removeEventListener('dblclick', this._onDbl);
      this.removeEventListener('keydown', this._onKey);
      this._disarmPress();
      this._scrub = false;
      if (this._raf) cancelAnimationFrame(this._raf), (this._raf = 0);
    }

    /** (Re)arm the devicePixelRatio watcher for the current ratio. */
    _watchDpr() {
      this._unwatchDpr();
      if (typeof matchMedia !== 'function') return;
      const dpr = window.devicePixelRatio || 1;
      this._dprMq = matchMedia(`(resolution: ${dpr}dppx)`);
      this._dprMq.addEventListener('change', this._onDprChange);
    }

    _unwatchDpr() {
      if (!this._dprMq) return;
      this._dprMq.removeEventListener('change', this._onDprChange);
      this._dprMq = null;
    }

    attributeChangedCallback(name, _old, val) {
      switch (name) {
        case 'theme':
          this._theme = val === 'light' ? 'light' : 'dark';
          break;
        case 'type':
          this._type = SERIES_TYPES.includes(val) ? val : 'candles';
          break;
        case 'log':
          this._log = val != null && val !== 'false';
          break;
        case 'auto':
          this._auto = val == null || val !== 'false';
          break;
        case 'precision':
          this._precision = val != null && val !== '' ? clamp(parseInt(val, 10) || 0, 0, 12) : null;
          break;
        case 'label':
          this._label = val || '';
          break;
        case 'indicators':
          this._ind = parseIndicators(val, WickChart._registry());
          break;
        case 'worker':
          this._workerOn = val != null && val !== 'false';
          this._invalidate();
          break;
        case 'stats':
          this._stats = val != null && val !== 'false';
          this._statsKey = '';
          break;
        case 'profile':
          this._profile = val != null && val !== 'false';
          this._profileKey = '';
          break;
        case 'annotations':
          this._annotations = val != null && val !== 'false';
          this._annoKey = '';
          break;
        case 'volshading':
          this._volshade = val != null && val !== 'false' ? parseVolShading(val) : null;
          this._legendKey = '';
          break;
        case 'overlays': {
          let ovs = [];
          if (val != null && val !== '') {
            try {
              ovs = normalizeOverlays(JSON.parse(val));
            } catch (err) {
              ovs = [];
            }
          }
          this._overlays = ovs;
          break;
        }
        case 'co-view':
          this._coviewName = val || null;
          this._setupCoView();
          break;
        case 'co-view-name':
          // display name travels with every presence message; no re-render
          this._coviewLabel = val || null;
          break;
        case 'brush':
          this._brush = val != null && val !== 'false';
          this._brushSel = null;
          this._brushDrag = null;
          this._invalidate();
          break;
        case 'sonify':
          this._sonify = val != null && val !== 'false';
          this._lastToneIdx = -1;
          break;
        // Default evaluation mode for alerts added without one. Anything
        // other than "close" means live, so a typo cannot silently mute
        // signals — it degrades to today's behaviour.
        case 'alert-evaluate':
          this._alertEval = val === 'close' ? 'close' : 'live';
          break;
        // Display zone for axis labels and the crosshair readout: 'local'
        // (default), 'utc', or an IANA name. Deliberately does NOT re-anchor
        // VWAP — the trading session is a separate question from how times
        // are shown; see calcVWAP's `anchor`.
        case 'timezone':
          this._tz = val || 'local';
          break;
        // Session anchor for VWAP: 'utc' (default), 'local', an IANA zone, or
        // a fixed offset in ms. Bumping the version drops the per-version
        // indicator cache so the series recomputes on the next frame.
        case 'vwap-anchor':
          this._vwapAnchor = val || 'utc';
          this._version++;
          break;
      }
      this._invalidate();
    }

    /* ------------------------------------------------------------ *
     * Indicator registry
     * ------------------------------------------------------------ */

    /** Indicator registry (module scope — shared with the legacy alias tag). */
    static _registry() {
      return REGISTRY;
    }

    /**
     * Register a custom indicator.
     *
     *   WickChart.registerIndicator('vwap', {
     *     kind: 'overlay',                    // or 'pane'
     *     params: { period: 20 },             // defaults; settable via name:period
     *     compute(bars, params) {             // bars: normalized {time,o,h,l,c,v}
     *       return smaOfCloses;               // single series…
     *       // …or { lines: [{name, values}], histogram } for multi-line/panes
     *     },
     *     guides: [30, 70],                   // pane only: dashed guide levels
     *     range: [0, 100],                    // pane only: fixed scale
     *     fmt: 'price' | 'fixed1',            // legend/axis number format
     *   });
     *   chart.indicators = 'vwap:20';
     */
    /** @param {import('./core.js').IndicatorDef} def */
    static registerIndicator(name, def) {
      if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
        throw new Error('registerIndicator: invalid name');
      }
      if (!def || typeof def.compute !== 'function') {
        throw new Error('registerIndicator: def.compute must be a function');
      }
      REGISTRY.set(name.toLowerCase(), {
        kind: def.kind === 'pane' ? 'pane' : 'overlay',
        ...def,
      });
    }

    /** The tag this class registers as. (<hab-chart> is a deprecated alias
     *  registered from the HabChart subclass, not this name.) */
    static get elementName() {
      return 'wick-chart';
    }

    /* ------------------------------------------------------------ *
     * Public API
     * ------------------------------------------------------------ */

    get data() {
      return this._data;
    }

    /**
     * Replace the dataset.
     * @param {Array<import('./core.js').Bar>} bars
     */
    setData(bars) {
      if (!Array.isArray(bars) || !bars.length) {
        this.clearData();
        return;
      }
      // selection indices are data-bound; a replacement invalidates them
      if (this._brushSel || this._brushDrag) this.clearBrush();
      const norm = [];
      for (const b of bars) {
        const nb = WickChart._normBar(b);
        if (nb) norm.push(nb);
      }
      // skip the O(n log n) sort when already ascending (typical for feeds)
      let sorted = true;
      for (let i = 1; i < norm.length; i++) {
        if (norm[i].time < norm[i - 1].time) {
          sorted = false;
          break;
        }
      }
      if (!sorted) norm.sort((a, b) => a.time - b.time);
      // One bar per timestamp. A REST history fetch and the websocket that
      // takes over from it overlap, so the same final candle routinely
      // arrives twice; the later copy is the corrected one and wins. In
      // place and allocation-free when the data is already unique.
      let dst = 0;
      for (let i = 0; i < norm.length; i++) {
        if (dst > 0 && norm[i].time === norm[dst - 1].time) norm[dst - 1] = norm[i];
        else norm[dst++] = norm[i];
      }
      norm.length = dst;
      this._data = norm;
      this._version++;
      this._epoch++;
      this._computeDt();
      // history is not a live signal: re-baseline so close-mode alerts only
      // fire on candles that close from here on
      this._syncClosedIdx();
      this._needsFit = true;
      this._auto = this._autoAttr();
      this._hover = null;
      this._noMore = false;
      this._updateAria();
      this._invalidate();
    }

    /**
     * Stream a bar: replaces the last bar when `time` matches, appends when
     * newer, inserts/backfills when older.
     * @param {import('./core.js').Bar} bar
     */
    update(bar) {
      const b = WickChart._normBar(bar);
      if (!b) return;
      const d = this._data;
      const last = d[d.length - 1];
      const prevClose = last ? last.close : NaN;
      // Only the front of the series is a live signal. A historical
      // correction or a backfilled candle must never be compared against the
      // latest price — that would fire an alert on a stale bar.
      let live = true;
      if (!last || b.time > last.time) {
        d.push(b);
        if (d.length > 1) this._computeDt();
      } else if (b.time === last.time) {
        d[d.length - 1] = b;
      } else {
        // out-of-order / backfill: replace matching or insert. Binary search
        // for the slot — a backward scan is O(n) per bar, which turns a
        // backfill of old candles into O(n·m) over a long history.
        live = false;
        const i = WickChart._indexForTime(d, b.time);
        if (d[i] && d[i].time === b.time) d[i] = b;
        else d.splice(i, 0, b);
        this._computeDt();
      }
      this._version++;
      // a live tick (append / forming-bar replace) patches every
      // online-capable series in O(warm-up) before the next render
      if (live) this._onlineTick();
      // Alerts run after the dataset AND the version are updated, so scripted
      // predicates evaluate over the bar that just arrived rather than
      // re-reading the previous version's memoized series.
      // A historical insert shifts indices without closing anything, so the
      // cursor moves with the data rather than reading as a fresh close.
      if (live) this._checkAlerts(prevClose, b);
      else this._syncClosedIdx();
      if (this._hover && this._hover.index >= d.length) this._hover = null;
      this._updateAria();
      this._invalidate();
    }

    clearData() {
      this._data = [];
      this._version++;
      this._epoch++;
      this._syncClosedIdx();
      this._hover = null;
      this._needsFit = true;
      this._noMore = false;
      this._updateAria();
      this._invalidate();
    }

    /**
     * Fetch older history when the view approaches the left edge.
     * The host app assigns `chart.onloadmore = async (fromTime) => bars`.
     * Bars strictly older than the current first bar are prepended and the
     * view stays anchored. Return [] / null to signal "no more data".
     * @type {null|((fromTime: number) => Promise<Array<import('./core.js').Bar>>|Array<import('./core.js').Bar>)}
     */
    onloadmore = null;

    _maybeLoadMore(iLeft) {
      if (this._loadingMore || this._noMore) return;
      if (typeof this.onloadmore !== 'function' || !this._data.length || !this._ly) return;
      const threshold = Math.max(2, (this._ly.plotRight / this._view.spacing) * 0.08);
      if (iLeft > threshold) return;
      const fromTime = this._data[0].time;
      this._loadingMore = true;
      Promise.resolve(this.onloadmore(fromTime))
        .then((bars) => {
          this._loadingMore = false;
          if (!this._connected) return;
          if (!Array.isArray(bars) || !bars.length) {
            this._noMore = true;
            return;
          }
          const older = [];
          for (const b of bars) {
            const nb = WickChart._normBar(b);
            if (nb) older.push(nb);
          }
          const { bars: merged, added } = mergeOlderData(this._data, older);
          if (!added) {
            this._noMore = true;
            return;
          }
          this._data = merged;
          this._version++;
          this._epoch++;
          this._computeDt();
          // keep the exact same bars on screen: every index shifts by `added`
          this._view.rightIndex += added;
          this._syncClosedIdx(); // backfill shifts indices, it closes nothing
          if (this._hover) this._hover.index = Math.min(this._hover.index + added, this._data.length - 1);
          this._clampView();
          this._invalidate();
        })
        .catch(() => {
          this._loadingMore = false;
          this._noMore = true;
        });
    }

    /** Reset zoom to the default view (last ~150 bars). */
    fit() {
      this._needsFit = true;
      this._auto = true;
      this._invalidate();
      this._emitRange();
    }

    /** Visible time window. @returns {{from:number,to:number}|null} */
    /** @returns {{from: number, to: number}|null} visible time window (ms) */
    getVisibleRange() {
      const d = this._data;
      if (!d.length || !this._ly) return null;
      const { plotRight } = this._ly;
      const { rightIndex, spacing } = this._view;
      const left = clamp(Math.round(rightIndex - plotRight / spacing), 0, d.length - 1);
      const right = clamp(Math.round(rightIndex), 0, d.length - 1);
      return { from: d[left].time, to: d[right].time };
    }

    /** Set visible time window ({from, to} in ms). */
    /** @param {{from: number, to: number}} range times in ms */
    setVisibleRange(range) {
      const d = this._data;
      if (!d.length || !range || !this._ly) return;
      const from = WickChart._timeToMs(range.from);
      const to = WickChart._timeToMs(range.to);
      let i0 = WickChart._indexForTime(d, from);
      let i1 = WickChart._indexForTime(d, to);
      if (i0 > i1) [i0, i1] = [i1, i0];
      if (i1 - i0 < 2) return;
      const { plotRight } = this._ly;
      this._view.spacing = clamp(plotRight / (i1 - i0), this._minSpacing(), WickChart._MAX_SP);
      this._view.rightIndex = i1;
      this._auto = false;
      this._clampView();
      this._invalidate();
      this._emitRange();
    }

    /** Current canvas as a PNG data URL. */
    exportPNG() {
      return this._canvas.toDataURL('image/png');
    }

    /**
     * AI-ready summary of the visible window: structured fields plus a
     * ready-to-paste markdown rendering (`text`). Computed locally —
     * nothing leaves the page until the user copies it somewhere.
     * @returns {object|null}
     */
    getDataWindow() {
      const d = this._data;
      if (!d.length || !this._ly) return null;
      const { plotRight } = this._ly;
      const { rightIndex, spacing } = this._view;
      const i0 = Math.max(0, Math.round(rightIndex - plotRight / spacing));
      const i1 = clamp(Math.round(rightIndex), 0, d.length - 1);
      const s = windowSummary(d, i0, i1, { dtMs: this._dt, label: this._label });
      if (!s) return null;
      // snapshot active indicator values at the right edge (scripts show their expression)
      const f = numberFmt(this._prec(d[i1].close));
      const snap = [];
      for (const entry of this._ind.overlays.concat(this._ind.panes)) {
        if (entry.name === 'volume') continue;
        const res = this._indicatorSeries(entry);
        for (const ln of res.lines) {
          const v = ln.values[i1];
          if (!isNum(v)) continue;
          const isScript = entry.name === 'expr' || entry.name === 'pexpr';
          const name = isScript
            ? ln.name || entry.name
            : entry.name + (Object.keys(entry.params).length ? ':' + Object.values(entry.params).join('/') : '');
          snap.push(`${name} = ${f.format(v)}`);
        }
      }
      if (snap.length) s.text += `\n- Indicators: ${snap.join('; ')}.`;
      return s;
    }

    /* ------------------------------------------------------------ *
     * State serialization
     * ------------------------------------------------------------ */

    /**
     * Serializable snapshot of the chart's configuration and view.
     * Feed it to setState() (or encodeStateQuery for shareable URLs).
     */
    /** @returns {import('./core.js').ChartState} */
    getState() {
      const range = this.getVisibleRange();
      const ind = [];
      if (this._ind.volume) ind.push('volume');
      for (const o of this._ind.overlays) ind.push(o.key);
      for (const p of this._ind.panes) ind.push(p.key);
      return {
        type: this._type,
        theme: this._theme,
        log: this._log,
        stats: this._stats,
        profile: this._profile,
        annotations: this._annotations,
        volshading: this._volshade
          ? `${this._volshade.p1}/${this._volshade.p2}`
          : false,
        indicators: ind.join(' '),
        view: range ? { from: range.from, to: range.to } : null,
        positions: this._positions.map((p) => ({
          id: p.id, side: p.side, entry: p.entry, stop: p.stop, target: p.target, qty: p.qty,
        })),
        alerts: this._alerts
          .filter((a) => !a.fired)
          .map((a) =>
            a.when != null
              ? { id: a.id, when: a.when, once: a.once, evaluate: a.evaluate }
              : { id: a.id, price: a.price, direction: a.direction, once: a.once, evaluate: a.evaluate }
          ),
      };
    }

    /**
     * Apply a state snapshot (from getState()). If a view range is included
     * and data is not loaded yet, it is applied after the next setData().
     * @param {import('./core.js').ChartState} state
     */
    setState(state) {
      if (!state || typeof state !== 'object') return;
      if (state.type) this.setAttribute('type', state.type);
      if (state.theme) this.setAttribute('theme', state.theme);
      if (typeof state.log === 'boolean') this.toggleAttribute('log', state.log);
      if (typeof state.stats === 'boolean') this.setAttribute('stats', String(state.stats));
      if (typeof state.profile === 'boolean') this.setAttribute('profile', String(state.profile));
      if (typeof state.annotations === 'boolean') this.setAttribute('annotations', String(state.annotations));
      if (state.volshading === true) this.setAttribute('volshading', 'true');
      else if (typeof state.volshading === 'string' && state.volshading) this.setAttribute('volshading', state.volshading);
      if (typeof state.label === 'string') this.setAttribute('label', state.label);
      if (typeof state.indicators === 'string') {
        this.setAttribute('indicators', state.indicators);
      }
      if (Array.isArray(state.positions)) {
        this._positions = state.positions
          .filter((p) => p && isNum(p.entry))
          .map((p) => ({
            id: p.id != null ? String(p.id) : 'pos-' + ++this._seq,
            side: p.side === 'short' ? 'short' : 'long',
            entry: p.entry,
            stop: isNum(p.stop) ? p.stop : null,
            target: isNum(p.target) ? p.target : null,
            qty: isNum(p.qty) ? p.qty : null,
          }));
        this._posVersion = (this._posVersion || 0) + 1;
      }
      if (Array.isArray(state.alerts)) {
        this._alerts = state.alerts
          .filter((a) => a && (isNum(a.price) || typeof a.when === 'string'))
          .map((a) => {
            if (typeof a.when === 'string' && a.when.trim()) {
              try {
                return {
                  id: a.id != null ? String(a.id) : 'alert-' + ++this._seq,
                  when: a.when.trim(),
                  compiled: compileScript(a.when),
                  once: a.once !== false,
                  evaluate: this._evalMode(a.evaluate),
                  fired: false,
                  armed: true,
                };
              } catch (err) {
                return null;
              }
            }
            return {
              id: a.id != null ? String(a.id) : 'alert-' + ++this._seq,
              price: a.price,
              direction: a.direction || 'cross',
              once: a.once !== false,
              evaluate: this._evalMode(a.evaluate),
              fired: false,
            };
          })
          .filter(Boolean);
      }
      if (state.view && state.view.from != null && state.view.to != null) {
        if (this._ly && this._data.length > 1) {
          this.setVisibleRange(state.view);
        } else {
          this._pendingRange = state.view;
        }
      }
      this._invalidate();
    }

    /* ------------------------------------------------------------ *
     * Positions & alerts
     * ------------------------------------------------------------ */

    /**
     * Visualize a position / order.
     * @param {{id?: string, side?: 'long'|'short', entry: number,
     *          stop?: number, target?: number, qty?: number}} pos
     * @returns {string|null} the position id
     */
    addPosition(pos) {
      if (!pos || !isNum(pos.entry)) return null;
      const p = {
        id: pos.id != null ? String(pos.id) : 'pos-' + ++this._seq,
        side: pos.side === 'short' ? 'short' : 'long',
        entry: pos.entry,
        stop: isNum(pos.stop) ? pos.stop : null,
        target: isNum(pos.target) ? pos.target : null,
        qty: isNum(pos.qty) ? pos.qty : null,
      };
      const i = this._positions.findIndex((x) => x.id === p.id);
      if (i >= 0) this._positions[i] = p;
      else this._positions.push(p);
      this._posVersion = (this._posVersion || 0) + 1;
      this._invalidate();
      return p.id;
    }

    removePosition(id) {
      this._positions = this._positions.filter((p) => p.id !== String(id));
      this._posVersion = (this._posVersion || 0) + 1;
      this._invalidate();
    }

    clearPositions() {
      this._positions = [];
      this._posVersion = (this._posVersion || 0) + 1;
      this._invalidate();
    }

    /**
     * Price or scripted alert. Price alerts fire `wick:alert`
     * ({id, price, bar}) on an edge crossing; scripted alerts evaluate a
     * WickScript predicate (`when`) on every streamed bar and fire on its
     * false→true edge — e.g. `when: 'crossup(rsi(close,14), 30)'` or
     * `when: 'volume > sma(volume,20) * 3'`. Scripted events carry the
     * triggering close as `price` plus the `when` source (deprecated
     * `hab:alert` alias still dispatched).
     * @param {{id?: string, price?: number, direction?: 'above'|'below'|'cross',
     *          when?: string, once?: boolean}} alert
     * @returns {string|null} the alert id (null when no valid price/when,
     *          or the predicate fails to compile)
     */
    addAlert(alert) {
      if (!alert) return null;
      let a;
      if (typeof alert.when === 'string' && alert.when.trim()) {
        let compiled;
        try {
          compiled = compileScript(alert.when);
        } catch (err) {
          return null;
        }
        a = {
          id: alert.id != null ? String(alert.id) : 'alert-' + ++this._seq,
          when: alert.when.trim(),
          compiled,
          once: alert.once !== false,
          evaluate: this._evalMode(alert.evaluate),
          fired: false,
          armed: true,
        };
      } else {
        if (!isNum(alert.price)) return null;
        a = {
          id: alert.id != null ? String(alert.id) : 'alert-' + ++this._seq,
          price: alert.price,
          direction: alert.direction || 'cross',
          once: alert.once !== false,
          evaluate: this._evalMode(alert.evaluate),
          fired: false,
        };
      }
      const i = this._alerts.findIndex((x) => x.id === a.id);
      if (i >= 0) this._alerts[i] = a;
      else this._alerts.push(a);
      this._invalidate();
      return a.id;
    }

    removeAlert(id) {
      this._alerts = this._alerts.filter((a) => a.id !== String(id));
      this._invalidate();
    }

    clearAlerts() {
      this._alerts = [];
      this._invalidate();
    }

    /**
     * Server-side overlays: zones & levels anchored in time × price — e.g.
     * supply/demand zones from an analysis API. Zones with no `to` extend
     * into future space past the last bar, like TradingView drawings.
     *
     *   zone:  { type:'zone', from?:ms, to?:ms|null, priceFrom, priceTo,
     *            color?, alpha?, border?, label?, id? }
     *   level: { type:'level', price, from?, to?, color?, width?, dash?,
     *            label?, id? }
     *
     * Invalid entries are dropped, never thrown. Colors accept hex/rgb()/CSS
     * names plus the palette keys 'up' | 'down' | 'accent'.
     * @param {object[]} list
     * @returns {string[]} applied overlay ids
     */
    setOverlays(list) {
      this._overlays = normalizeOverlays(list);
      this._invalidate();
      return this._overlays.map((o) => o.id);
    }

    /** @returns {object[]} a copy of the current overlays */
    get overlays() {
      return this._overlays.map((o) => ({ ...o }));
    }

    /**
     * Add or replace (upsert, by id) a single overlay.
     * @returns {string|null} the overlay id, or null if invalid
     */
    addOverlay(ov) {
      const norm = normalizeOverlays([ov]);
      if (!norm.length) return null;
      const one = norm[0];
      const i = this._overlays.findIndex((x) => x.id === one.id);
      if (i >= 0) this._overlays[i] = one;
      else this._overlays.push(one);
      this._invalidate();
      return one.id;
    }

    removeOverlay(id) {
      this._overlays = this._overlays.filter((o) => o.id !== String(id));
      this._invalidate();
    }

    clearOverlays() {
      this._overlays = [];
      this._invalidate();
    }

    /**
     * Scenario projection into future space: a ghost path of future prices
     * plus optional σ-bands (vol cone) from realized volatility.
     *
     *   chart.setScenario({ path: [64000, 65500, 68000], label: 'bull case' });
     *   chart.setScenario({ horizon: 48, cone: true });   // cone-only
     *
     * The path is an array of prices (or {price} objects) for future bars
     * 1..N; horizon defaults to the path length (1–500). `cone` (default
     * true) draws ±levels·σ bands widening with √h from the current realized
     * vol; `color` accepts up|down|accent or safe CSS colors. Setting a
     * scenario reserves future space on the right; analysis data — excluded
     * from getState/setState.
     * @param {object} spec
     * @returns {object|null} the normalized scenario, or null when invalid
     */
    setScenario(spec) {
      this._scenario = normalizeScenario(spec);
      this._invalidate();
      return this._scenario;
    }

    clearScenario() {
      this._scenario = null;
      this._invalidate();
    }

    /** @returns {object|null} a copy of the active scenario */
    get scenario() {
      if (!this._scenario) return null;
      return { ...this._scenario, path: this._scenario.path.map((p) => ({ ...p })) };
    }

    /**
     * Risk plan: an R-multiple grid anchored at entry/stop. 1R = |entry −
     * stop| (the risk unit); reward lines are drawn at kR beyond the entry
     * with the risk/reward zones shaded, so sizing and take-profit choices
     * read directly off the chart.
     *
     *   chart.setRiskPlan({ entry: 64500, stop: 63800, multiples: [1, 2, 3] });
     *   chart.setRiskPlan({ entry: 64500, stop: 63800, targets: [65900, 67300] });
     *
     * Direction is derived (stop below entry ⇒ long). Targets convert to
     * their R multiple; `multiples` win when both are given. Invalid specs
     * clear the plan (replace semantics, like setScenario); excluded from
     * getState/setState — it is app state, not chart state.
     * @param {object} spec
     * @returns {object|null} the normalized plan, or null when invalid
     */
    setRiskPlan(spec) {
      this._riskPlan = normalizeRiskPlan(spec);
      this._invalidate();
      return this._riskPlan;
    }

    clearRiskPlan() {
      if (this._riskPlan) {
        this._riskPlan = null;
        this._invalidate();
      }
    }

    /** @returns {object|null} a copy of the active risk plan */
    get riskPlan() {
      if (!this._riskPlan) return null;
      return { ...this._riskPlan, levels: this._riskPlan.levels.map((l) => ({ ...l })) };
    }

    /** σ-cone for the active scenario, cached per data version. */
    _scenarioConeCache() {
      if (!this._scenario || !this._data.length) return null;
      if (this._cache.v !== this._version) {
        this._cache = { v: this._version, map: {} };
      }
      if (!this._cache.map.__scenario) {
        const d = this._data;
        const vol = calcRealizedVol(d.map((b) => b.close), 20);
        let v = NaN;
        for (let i = vol.length - 1; i >= 0; i--) {
          if (Number.isFinite(vol[i])) { v = vol[i]; break; }
        }
        this._cache.map.__scenario = calcVolCone(
          d[d.length - 1].close,
          v,
          this._scenario.horizon,
          this._scenario.levels
        );
      }
      return this._cache.map.__scenario;
    }

    /* ------------------------------------------------------------ *
     * AI agent interface — the chart as a tool surface
     * ------------------------------------------------------------ */

    /** Tool manifest for LLM control — JSON-safe copy of AI_TOOLS. */
    aiTools() {
      return JSON.parse(JSON.stringify(AI_TOOLS));
    }

    /** System prompt for agent control — paste into any LLM alongside aiTools(). */
    aiPrompt() {
      return aiPromptText();
    }

    /** Grounding context for a model: current state + visible-window summary. */
    aiContext() {
      return { state: this.getState(), window: this.getDataWindow() };
    }

    /**
     * Apply a list of {tool, args} ops (typically LLM output) through the
     * validated dispatcher in core. Never throws — each op resolves
     * {ok, tool, result} or {ok: false, tool, error} so an agent can
     * self-correct.
     * @param {any} ops
     * @returns {Array<object>}
     */
    applyAI(ops) {
      return applyChartOps(this, ops);
    }

    /**
     * Ask an AI to operate the chart. Builds the payload {system,
     * instruction, chart, tools}; with a `run` async function (your model
     * call — the chart itself never touches the network), applies the
     * returned ops and resolves {payload, ops, results}. Without `run`,
     * returns the payload for manual wiring — send it anywhere, then call
     * chart.applyAI(ops) with the model's answer.
     *
     *   const { results } = await chart.ask('add RSI and mark the demand zone', {
     *     run: async (payload) => (await callMyLLM(payload)).ops,
     *   });
     *
     * @param {string} instruction natural-language request
     * @param {{run?: (payload: object) => Promise<any>}} [opts]
     */
    async ask(instruction, opts = {}) {
      const payload = {
        system: aiPromptText(),
        instruction: String(instruction == null ? '' : instruction),
        chart: this.aiContext(),
        tools: this.aiTools(),
      };
      if (typeof opts.run !== 'function') {
        return { payload, ops: null, results: null };
      }
      const ops = await opts.run(payload);
      const results = this.applyAI(ops);
      return { payload, ops, results };
    }

    /** Check alerts against an incoming bar (prev close → new close).
     *  Scripted (`when`) alerts evaluate their predicate series, cached per
     *  data version, and fire on the false→true edge. */
    /**
     * Index of the newest bar known to be final: any bar with a newer bar
     * behind it, plus the front bar when the feed flagged it `closed: true`
     * (Binance's `k.x`). -1 when nothing has closed yet.
     */
    _lastClosedIndex() {
      const d = this._data;
      if (!d.length) return -1;
      const last = d.length - 1;
      return d[last] && d[last].closed === true ? last : last - 1;
    }

    /** Re-baseline the closed-bar cursor without firing anything. */
    _syncClosedIdx() {
      this._lastClosedIdx = this._lastClosedIndex();
    }

    /**
     * Resolve an alert's evaluation mode: an explicit 'close' / 'live' on the
     * alert wins, otherwise the chart-level `alert-evaluate` default (itself
     * 'live', so 1.x behaviour is unchanged unless asked for).
     * @param {string|undefined} v
     * @returns {'live'|'close'}
     */
    _evalMode(v) {
      if (v === 'close' || v === 'live') return v;
      return this._alertEval === 'close' ? 'close' : 'live';
    }

    /** Dispatch one alert, retiring it when it was a `once` alert. */
    _fireAlert(alert, detail) {
      if (alert.once) alert.fired = true;
      this._fire('alert', { id: alert.id, ...detail });
      if (alert.once) this._alerts = this._alerts.filter((x) => x !== alert);
    }

    _checkAlerts(prevClose, bar) {
      const closedIdx = this._lastClosedIndex();
      // A bar closing is an edge, not a level: close-mode alerts evaluate
      // only on the update that finalizes a candle, so a candle that ticks
      // through a threshold and back never produces a signal.
      const justClosed = closedIdx > this._lastClosedIdx;
      if (justClosed) this._lastClosedIdx = closedIdx;
      if (!this._alerts.length) return;
      const d = this._data;
      for (const a of [...this._alerts]) {
        // `fired` means "spent forever" — it is only ever set on `once`
        // alerts. Repeating (once:false) alerts re-fire on every edge:
        // price alerts are edge-triggered by checkAlertCross(), scripted
        // ones by the armed/scriptAlertStep() latch.
        if (a.fired) continue;

        // Close mode reads the newest final candle; live mode reads the
        // front of the series, forming or not.
        const onClose = a.evaluate === 'close';
        if (onClose && (!justClosed || closedIdx < 0)) continue;
        const idx = onClose ? closedIdx : d.length - 1;
        const cur = onClose ? d[idx] : bar;
        if (!cur) continue;

        if (a.when != null) {
          // predicates are causal, so the value at `idx` is the same whether
          // it was computed over the whole series or just the prefix
          const step = scriptAlertStep(a.armed, this._predicateCache(a)[idx] === true);
          a.armed = step.armed;
          if (step.fire) this._fireAlert(a, { price: cur.close, when: a.when, bar: cur });
          continue;
        }
        const prev = onClose ? (d[idx - 1] ? d[idx - 1].close : NaN) : prevClose;
        if (!isNum(prev)) continue;
        if (checkAlertCross(a, prev, cur.close)) {
          this._fireAlert(a, { price: a.price, bar: cur });
        }
      }
    }

    /** Cached boolean series for a scripted alert's predicate (per data version). */
    _predicateCache(alert) {
      if (this._cache.v !== this._version) {
        this._cache = { v: this._version, map: {} };
      }
      const k = 'pred:' + alert.when;
      if (!this._cache.map[k]) {
        this._cache.map[k] = predicateTrueSeries(alert.compiled, this._data);
      }
      return this._cache.map[k];
    }

    /* reflected properties */
    get theme() { return this._theme; }
    set theme(v) { this.setAttribute('theme', v); }
    get type() { return this._type; }
    set type(v) { this.setAttribute('type', v); }
    get label() { return this._label; }
    set label(v) { this.setAttribute('label', v); }
    get indicators() {
      return this.getAttribute('indicators');
    }
    set indicators(v) { this.setAttribute('indicators', v == null ? '' : v); }

    /* ------------------------------------------------------------ *
     * Normalization / internals
     * ------------------------------------------------------------ */

    static _MAX_SP = 90;

    /** Hold this long on a touchscreen to open the crosshair (ms). */
    static _PRESS_MS = 350;
    /** Finger travel that cancels the press and makes it a pan (px). */
    static _PRESS_SLOP = 10;

    /**
     * Lowest allowed px/bar: either 0.35, or whatever fits the entire
     * dataset on screen — so any history can be zoomed out fully.
     */
    _minSpacing() {
      const ly = this._ly;
      const w = ly ? ly.plotRight : 600;
      return Math.min(0.35, w / Math.max(60, this._data.length));
    }

    static _timeToMs(t) {
      if (t instanceof Date) return t.getTime();
      return isNum(t) ? toMs(t) : Date.now();
    }

    static _normBar(b) {
      if (!b) return null;
      const t = b.time != null ? b.time : b.t;
      if (!isNum(t) && !(t instanceof Date)) return null;
      const time = WickChart._timeToMs(t);
      const close = isNum(b.close) ? b.close : isNum(b.value) ? b.value : NaN;
      if (!isNum(close)) return null;
      const open = isNum(b.open) ? b.open : close;
      const nb = {
        time,
        open,
        high: isNum(b.high) ? b.high : Math.max(open, close),
        low: isNum(b.low) ? b.low : Math.min(open, close),
        close,
        volume: isNum(b.volume) ? b.volume : isNum(b.v) ? b.v : 0,
      };
      // Only carried when the feed actually says the candle is final
      // (Binance `k.x`), so the bar shape is unchanged for everyone else.
      if (b.closed === true) nb.closed = true;
      return nb;
    }

    static _indexForTime(d, time) {
      let lo = 0;
      let hi = d.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (d[mid].time < time) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    _autoAttr() {
      const a = this.getAttribute('auto');
      return a == null || a !== 'false';
    }

    _computeDt() {
      const d = this._data;
      const n = d.length;
      if (n < 2) {
        this._dt = HOUR;
        return;
      }
      const diffs = [];
      const from = Math.max(1, n - 300);
      for (let i = from; i < n; i++) {
        const df = d[i].time - d[i - 1].time;
        if (df > 0) diffs.push(df);
      }
      if (!diffs.length) {
        this._dt = HOUR;
        return;
      }
      diffs.sort((a, b) => a - b);
      this._dt = diffs[diffs.length >> 1] || HOUR;
    }

    _updateAria() {
      const d = this._data;
      const last = d[d.length - 1];
      const prev = d[d.length - 2];
      if (!last) {
        this._canvas.setAttribute('aria-label', (this._label || 'Chart') + ': no data');
        return;
      }
      const pct = prev ? ((last.close - prev.close) / prev.close) * 100 : 0;
      this._canvas.setAttribute(
        'aria-label',
        `${this._label || 'Chart'}: last ${numberFmt(this._prec(last.close)).format(last.close)}, ${pct >= 0 ? '+' : ''}${pct.toFixed(2)} percent, ${d.length} bars`
      );
    }

    _invalidate() {
      if (!this._connected || this._raf) return;
      this._raf = requestAnimationFrame(() => this._render());
    }

    _prec(v) {
      return this._precision != null ? this._precision : autoPrecision(v);
    }

    _palette() {
      if (this._pal && this._palKey === this._theme) return this._pal;
      const base = THEMES[this._theme] || THEMES.dark;
      const cs = getComputedStyle(this);
      // --wick-* is canonical; --hab-* still honored as the 0.x fallback
      const get = (name, fallback) => {
        const v = cs.getPropertyValue('--wick-' + name).trim();
        if (v) return v;
        const h = cs.getPropertyValue('--hab-' + name).trim();
        if (h) warnDeprecatedAlias('--hab-* variables are removed in 2.0 — rename to --wick-*');
        return h || fallback;
      };
      const pal = {};
      for (const k of Object.keys(base)) {
        if (k === 'overlay') {
          const o = [];
          for (let i = 0; i < base.overlay.length; i++) {
            o.push(get('overlay-' + i, base.overlay[i]));
          }
          // allow single overlay color
          const single = get('overlay', '');
          pal.overlay = single ? base.overlay.map(() => single) : o;
        } else {
          pal[k] = get(k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), base[k]);
        }
      }
      pal.volAlpha = parseFloat(pal.volAlpha);
      if (!isNum(pal.volAlpha)) pal.volAlpha = 0.33;
      this._pal = pal;
      this._palKey = this._theme;
      return pal;
    }

    /**
     * Bars used for drawing/reading OHLC: raw data, or the Heikin-Ashi
     * transform for `type="heikin"` (cached per data version).
     */
    _renderBars() {
      if (this._type !== 'heikin') return this._data;
      if (this._cache.v !== this._version || !this._cache.map.__heikin) {
        if (this._cache.v !== this._version) this._cache = { v: this._version, map: {} };
        this._cache.map.__heikin = calcHeikinAshi(this._data);
      }
      return this._cache.map.__heikin;
    }

    /** RSI(14) over raw closes, cached per data version (annotation input). */
    _cachedRSI14() {
      if (this._cache.v !== this._version) {
        this._cache = { v: this._version, map: {} };
      }
      if (!this._cache.map.__rsi14) {
        this._cache.map.__rsi14 = calcRSI(this._data.map((b) => b.close), 14);
      }
      return this._cache.map.__rsi14;
    }

    /** Volatility-regime data (realized vol + percentile bands), cached per data version. */
    _volShadeCache() {
      if (!this._volshade) return null;
      if (this._cache.v !== this._version) {
        this._cache = { v: this._version, map: {} };
      }
      if (!this._cache.map.__volshade) {
        const closes = this._data.map((b) => b.close);
        const vol = calcRealizedVol(closes, this._volshade.period);
        this._cache.map.__volshade = {
          vol,
          ...volRegimeBands(vol, this._volshade.p1, this._volshade.p2),
        };
      }
      return this._cache.map.__volshade;
    }

    /** Compute (and cache per data version) an indicator entry's series. */
    _indicatorSeries(entry) {
      {
        // incremental path first: a series patched for this exact version
        // by _onlineTick is the freshest thing there is
        const on = this._onlineSeries;
        const cur = on.epoch === this._epoch ? on.map['ind:' + entry.key] : null;
        if (cur && cur.v === this._version) return cur.res;
      }
      if (this._cache.v !== this._version) {
        this._cache = { v: this._version, map: {} };
      }
      const k = 'ind:' + entry.key;
      if (!this._cache.map[k]) {
        // Worker compute path: built-in indicators over big histories run
        // off the main thread. The dataset crosses once per data epoch as
        // six transferable Float64Arrays (~25 ms/M bars — cloning objects
        // would cost ~1 s). Closures (custom/scripted defs) can't cross;
        // neither can anything below WORKER_MIN_BARS — both stay sync.
        const pool = WickChart._workerPool;
        if (pool && pool.available && this._workerOn && this._data.length >= WORKER_MIN_BARS &&
            BUILTIN_INDICATORS.get(entry.name) === entry.def) {
          const wc = this._workerCache;
          if (wc.epoch === this._epoch && wc.map[k]) return wc.map[k];
          this._workerCompute(pool, entry, k);
          return PENDING_SERIES; // the line lands when the result arrives
        }
        let res;
        try {
          // the session anchor rides along for indicators that observe one
          // (vwap); the rest ignore the extra key
          res = entry.def.compute(this._data, { ...entry.params, anchor: this._vwapAnchor });
        } catch (err) {
          res = null;
        }
        this._cache.map[k] = normalizeIndicatorResult(res);
        this._seedOnline(k, entry, this._cache.map[k]);
      }
      return this._cache.map[k];
    }

    /**
     * After a live stream tick (append or forming-bar replace), patch every
     * online-capable series by recomputing a bounded tail with the same
     * batch definition — O(warm-up) instead of a full-history recompute per
     * indicator per tick. Bases are seeded by the sync or worker path; bulk
     * loads (epoch changes) reseed automatically.
     */
    _onlineTick() {
      const d = this._data;
      const on = this._onlineSeries;
      if (!d.length || on.epoch !== this._epoch) return;
      for (const entry of this._ind.overlays.concat(this._ind.panes)) {
        const k = 'ind:' + entry.key;
        const cur = on.map[k];
        if (!cur || ONLINE_SKIP.has(entry.name) || BUILTIN_INDICATORS.get(entry.name) !== entry.def) {
          continue;
        }
        if (this._patchSeriesTail(cur.res, entry, d)) cur.v = this._version;
        else delete on.map[k]; // length mismatch etc. — reseed on the next compute
      }
    }

    /** Recompute the last K bars of one series in place (K = max(400,
     *  10×period), clamped to the data). False when the series and data
     *  lengths can't line up — the caller drops the base and reseeds. */
    _patchSeriesTail(res, entry, d) {
      let p = 0;
      for (const v of Object.values(entry.params || {})) {
        if (Number.isFinite(+v) && +v > p) p = +v;
      }
      const K = Math.min(d.length - 1, Math.max(ONLINE_WARMUP, p * 10));
      if (K < 2 || !res.lines.length) return false;
      let tail;
      try {
        tail = normalizeIndicatorResult(
          entry.def.compute(d.slice(d.length - 1 - K), { ...entry.params, anchor: this._vwapAnchor })
        );
      } catch (_) {
        return false;
      }
      const want = d.length;
      const base = want - 1 - K; // data index of tail[0]
      // Only the last `p` values can have changed (window indicators depend
      // on the trailing window alone; recursive ones only move the new bar).
      // Writing deeper would replace good full-history values with the
      // tail's own warm-up error.
      const from = Math.max(base, want - 1 - p);
      const patch = (dst, src) => {
        if (!Array.isArray(src) || src.length !== K + 1) return false;
        if (dst.length === want - 1) dst.push(src[src.length - 1]); // a bar was appended
        else if (dst.length !== want) return false;
        for (let di = from; di < want; di++) {
          const v = src[di - base];
          if (v != null || dst[di] == null) dst[di] = v; // warm-up null never clobbers
        }
        return true;
      };
      for (let i = 0; i < res.lines.length; i++) {
        const t = tail.lines[i];
        if (!t || !patch(res.lines[i].values, t.values)) return false;
      }
      if (Array.isArray(res.histogram) && !patch(res.histogram, tail.histogram)) return false;
      return true;
    }

    /** Remember a fresh series as the base for incremental tick updates
     *  (online-capable builtins only). */
    _seedOnline(k, entry, res) {
      if (ONLINE_SKIP.has(entry.name) || BUILTIN_INDICATORS.get(entry.name) !== entry.def) return;
      const on = this._onlineSeries;
      if (on.epoch !== this._epoch) {
        on.epoch = this._epoch;
        on.map = {};
      }
      on.map[k] = { v: this._version, res };
    }

    /** Bar count from which the worker path engages (below it, sync wins). */
    _workerCols() {
      const d = this._data;
      const n = d.length;
      const cols = {
        time: new Float64Array(n), open: new Float64Array(n), high: new Float64Array(n),
        low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n),
      };
      for (let i = 0; i < n; i++) {
        const b = d[i];
        cols.time[i] = b.time;
        cols.open[i] = b.open;
        cols.high[i] = b.high;
        cols.low[i] = b.low;
        cols.close[i] = b.close;
        cols.volume[i] = b.volume || 0;
      }
      return cols;
    }

    /** Kick an off-thread compute for one indicator (idempotent per epoch). */
    _workerCompute(pool, entry, k) {
      const wc = this._workerCache;
      wc.epoch = this._epoch;
      if (wc.sent !== this._epoch) {
        wc.sent = this._epoch;
        wc.pending = {};
        pool
          .run({ type: 'epoch', sid: this._sid, epoch: this._epoch, cols: this._workerCols() })
          .catch(() => {
            if (wc.sent === this._epoch) wc.sent = -1; // resend on the next kick
          });
      }
      if (wc.pending[k] === this._epoch) return; // already in flight
      wc.pending[k] = this._epoch;
      const epoch = this._epoch; // captured at kick time — a bulk load that
      // lands while the compute is in flight must not adopt its result
      pool
        .run({
          type: 'indicator', sid: this._sid, epoch,
          name: entry.name, params: { ...entry.params, anchor: this._vwapAnchor },
        })
        .then((res) => this._workerArrived(k, epoch, res, entry))
        .catch((err) => {
          delete wc.pending[k];
          if (err && err.stale && wc.sent === this._epoch) {
            wc.sent = -1; // the worker no longer holds this epoch's data — resend
          } else if (wc.epoch === epoch) {
            wc.map[k] = { lines: [], histogram: null }; // negative cache: draw nothing this epoch
          }
        });
    }

    _workerArrived(k, epoch, res, entry) {
      const wc = this._workerCache;
      delete wc.pending[k];
      if (wc.epoch !== epoch) return; // a newer bulk load won — drop the stale line
      const norm = normalizeIndicatorResult(res);
      wc.map[k] = norm;
      // the worker base doubles as the seed for incremental tick updates,
      // so streamed ticks stay fresh instead of waiting for the next load
      if (entry) this._seedOnline(k, entry, norm);
      this._fire('worker', { key: k, epoch });
      this._invalidate();
    }

    /** Resolve a line color: #hex / rgb() / CSS name / palette key ('rsi', 'up', …) / cycle.
     *  Untrusted values (URL/attribute-sourced) are validated — never interpolated raw. */
    _lineColor(entry, line, pal, cycleIdx) {
      const raw =
        (line && line.color) ||
        (entry && entry.color) ||
        (entry && entry.def && entry.def.color) ||
        null;
      const fallback = pal.overlay[cycleIdx % pal.overlay.length];
      if (!raw) return fallback;
      const c = safeColor(raw);
      if (!c) return fallback; // injection attempt or garbage → safe default
      return pal[c] || c;
    }

    /* ------------------------------------------------------------ *
     * Layout / view helpers
     * ------------------------------------------------------------ */

    _ensureCanvas() {
      const W = this.clientWidth;
      const H = this.clientHeight;
      if (!W || !H) return false;
      const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
      const bw = Math.round(W * dpr);
      const bh = Math.round(H * dpr);
      if (this._canvas.width !== bw || this._canvas.height !== bh) {
        this._canvas.width = bw;
        this._canvas.height = bh;
      }
      this._W = W;
      this._H = H;
      this._dpr = dpr;
      return true;
    }

    _rightMargin() {
      const ly = this._ly;
      const w = ly ? ly.plotRight : 600;
      const base = Math.max(3, (w / this._view.spacing) * 0.06);
      // a scenario projection reserves future space so the cone stays visible
      return this._scenario ? Math.max(base, this._scenario.horizon + 3) : base;
    }

    _applyFit() {
      const d = this._data;
      if (!d.length || !this._ly) return;
      const { plotRight } = this._ly;
      const target = Math.min(d.length, 150);
      this._view.spacing = clamp(plotRight / target, this._minSpacing(), WickChart._MAX_SP);
      this._view.rightIndex = d.length - 1 + this._rightMargin();
    }

    _clampView() {
      const d = this._data;
      const ly = this._ly;
      if (!d.length || !ly) return;
      const v = this._view;
      v.spacing = clamp(v.spacing, this._minSpacing(), WickChart._MAX_SP);
      const visible = ly.plotRight / v.spacing;
      const maxRight = d.length - 1 + Math.max(6, visible * 0.5);
      const minRight = Math.min(2, d.length - 1);
      v.rightIndex = clamp(v.rightIndex, minRight, maxRight);
    }

    _atRight() {
      const d = this._data;
      if (!d.length) return true;
      const ri = this._view.rightIndex;
      const m = this._rightMargin();
      return ri >= d.length - 1 - 0.5 && ri <= d.length - 1 + m + 1;
    }

    _xFor(i) {
      const ly = this._ly;
      return ly ? ly.plotRight - (this._view.rightIndex - i) * this._view.spacing : 0;
    }

    _indexForX(x) {
      const ly = this._ly;
      if (!ly) return 0;
      return this._view.rightIndex - (ly.plotRight - x) / this._view.spacing;
    }

    /* ------------------------------------------------------------ *
     * Scales & ticks
     * ------------------------------------------------------------ */

    _mainScale(i0, i1, cols) {
      const d = this._renderBars();
      const candles = this._type === 'candles' || this._type === 'hollow' || this._type === 'bars' || this._type === 'heikin';
      let lo = Infinity;
      let hi = -Infinity;
      if (cols) {
        for (const c of cols) {
          const h = candles ? c.high : c.close;
          const l = candles ? c.low : c.close;
          if (l < lo) lo = l;
          if (h > hi) hi = h;
        }
      } else {
        for (let i = i0; i <= i1; i++) {
          const b = d[i];
          if (candles) {
            if (b.low < lo) lo = b.low;
            if (b.high > hi) hi = b.high;
          } else {
            if (b.close < lo) lo = b.close;
            if (b.close > hi) hi = b.close;
          }
        }
      }
      for (const ov of this._ind.overlays) {
        const res = this._indicatorSeries(ov);
        for (const ln of res.lines) {
          const s = ln.values;
          if (cols) {
            for (const c of cols) {
              const val = s[c.i1];
              if (isNum(val)) {
                if (val < lo) lo = val;
                if (val > hi) hi = val;
              }
            }
          } else {
            for (let i = i0; i <= i1; i++) {
              const v = s[i];
              if (isNum(v)) {
                if (v < lo) lo = v;
                if (v > hi) hi = v;
              }
            }
          }
        }
      }
      if (!isFinite(lo) || !isFinite(hi)) {
        lo = 0;
        hi = 1;
      }
      if (hi === lo) {
        const e = Math.abs(hi) * 0.005 || 1;
        hi += e;
        lo -= e;
      }
      const pad = (hi - lo) * 0.08;
      let min = lo - pad;
      let max = hi + pad;
      const useLog = this._log && min > 0;
      if (useLog) {
        min = Math.log10(min);
        max = Math.log10(max);
        if (max - min < 1e-9) max = min + 1;
      }
      return { min, max, useLog, rawMin: lo, rawHi: hi };
    }

    _priceTicks(scale, height) {
      const target = clamp(Math.round(height / 60), 3, 9);
      const step = niceStep(scale.rawHi - scale.rawMin, target);
      const ticks = [];
      if (!(step > 0)) return ticks;
      const start = Math.ceil(scale.rawMin / step) * step;
      for (let v = start, guard = 0; v <= scale.rawHi && guard < 200; v += step, guard++) {
        ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
      }
      return ticks;
    }

    /**
     * Time-axis ticks. `sampleIdx` (optional, ascending indices) restricts
     * the walk to those bars — used at deep zoom where bars are aggregated
     * into pixel columns (keeps this O(screen) instead of O(visible bars)).
     */
    /** An instant shifted into the chart's display zone, for the formatters. */
    _zt(t) {
      return t + zoneOffset(t, this._tz);
    }

    _timeTicks(i0, i1, sampleIdx) {
      const d = this._data;
      const sp = this._view.spacing;
      const dt = this._dt || HOUR;
      const minPx = 88;

      // choose step: fixed steps first, then month/year steps
      let stepMs = null;
      let stepLabel = 'time';
      for (const s of TIME_STEPS) {
        if ((s.ms / dt) * sp >= minPx) {
          stepMs = s.ms;
          stepLabel = s.label;
          break;
        }
      }
      let monthStep = 0;
      let yearStep = 0;
      if (stepMs == null) {
        const monthsPx = (30 * DAY / dt) * sp;
        if (monthsPx >= minPx) {
          monthStep = monthsPx >= minPx * 6 ? 6 : monthsPx >= minPx * 3 ? 3 : 1;
        } else {
          yearStep = 1;
        }
      }

      const ticks = [];
      let prevKey = null;
      // Labels are built lazily — only for bars that actually start a new step.
      // Formatting every visible bar (toLocaleDateString) once cost ~30µs/bar.
      const visit = (i) => {
        if (i < 0 || i >= d.length) return;
        const t = d[i].time;
        // shifted into the display zone once, then read with UTC getters
        const zt = this._zt(t);
        let key;
        let label = null;
        if (stepMs != null) {
          key = Math.floor(zt / stepMs);
          if (prevKey !== null && key !== prevKey) {
            if (stepLabel === 'time') {
              const prevT = d[i - 1] ? d[i - 1].time : t;
              const dayKey = Math.floor(zt / DAY);
              const prevDay = Math.floor(this._zt(prevT) / DAY);
              label = dayKey !== prevDay ? fmtDay(zt) : hhmm(zt);
            } else {
              const dt_ = new Date(zt);
              label = dt_.getUTCDate() === 1 ? fmtMonth(zt, dt_.getUTCMonth() === 0) : fmtDay(zt);
            }
          }
        } else if (monthStep) {
          const dt_ = new Date(zt);
          key = Math.floor((dt_.getUTCFullYear() * 12 + dt_.getUTCMonth()) / monthStep);
          if (prevKey !== null && key !== prevKey) {
            label = fmtMonth(zt, dt_.getUTCMonth() === 0 || monthStep > 1);
          }
        } else {
          key = new Date(zt).getUTCFullYear();
          if (prevKey !== null && key !== prevKey) label = fmtYear(zt);
        }
        if (label !== null) ticks.push({ x: this._xFor(i), label });
        prevKey = key;
      };
      if (sampleIdx) {
        for (const i of sampleIdx) visit(i);
      } else {
        for (let i = Math.max(0, i0 - 1); i <= i1; i++) visit(i);
      }
      return ticks;
    }

    /* ------------------------------------------------------------ *
     * Render
     * ------------------------------------------------------------ */

    _render() {
      this._raf = 0;
      if (!this._connected) return;
      if (!this._ensureCanvas()) return;

      const ctx = this._ctx;
      ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
      const pal = this._palette();
      const d = this._renderBars();
      const W = this._W;
      const H = this._H;

      /* layout */
      ctx.font = axisFont();
      let priceW = 0;
      const measure = (v) => ctx.measureText(v).width;
      {
        const sample = d.length ? d[d.length - 1].close : 0;
        const p = this._prec(sample || 1);
        const f = numberFmt(p);
        priceW = Math.max(
          52,
          Math.ceil(
            Math.max(
              measure(f.format(sample || 1000)),
              measure(fmtCompact(1234567))
            )
          ) + 16
        );
      }
      const timeH = 26;
      const dock = this._dockInset();
      const plotRight = Math.max(30, W - priceW);
      const plotBottom = H - timeH - dock;
      const paneList = this._ind.panes;
      const paneArea = paneList.length
        ? Math.min(
            Math.round(plotBottom * 0.55),
            paneList.length * clamp(Math.round(plotBottom * 0.26), 60, 190)
          )
        : 0;
      const eachPaneH = paneList.length ? Math.floor(paneArea / paneList.length) : 0;
      const mainH = plotBottom - (paneList.length ? paneList.length * (eachPaneH + 1) : 0);
      const panes = paneList.map((entry, k) => {
        const y0 = mainH + 1 + k * (eachPaneH + 1);
        return { entry, y0, y1: y0 + eachPaneH - 1, h: eachPaneH - 1 };
      });
      const ly = (this._ly = {
        W,
        H,
        priceW,
        timeH,
        plotRight,
        plotBottom,
        main: { y0: 0, y1: mainH, h: mainH },
        panes,
        dock: dock > 0 ? { y0: H - dock, h: dock } : null,
      });

      /* background */
      ctx.fillStyle = pal.bg;
      ctx.fillRect(0, 0, W, H);
      this._nodata.hidden = d.length > 0;
      if (!d.length) {
        this._legend.innerHTML = '';
        this._poss.innerHTML = '';
        this._statsRow.innerHTML = '';
        this._legendKey = 'empty';
        return;
      }

      /* view */
      if (this._needsFit) {
        this._applyFit();
        this._needsFit = false;
      }
      if (this._auto) this._view.rightIndex = d.length - 1 + this._rightMargin();
      this._clampView();
      if (this._pendingRange) {
        const pr = this._pendingRange;
        this._pendingRange = null;
        this.setVisibleRange(pr);
      }

      const v = this._view;
      const sp = v.spacing;
      const count = plotRight / sp;
      const iLeft = v.rightIndex - count;
      const i0 = Math.max(0, Math.floor(iLeft) - 1);
      const i1 = Math.min(d.length - 1, Math.ceil(v.rightIndex) + 1);
      this._maybeLoadMore(iLeft);

      // deep zoom-out: aggregate bars into ~1px columns so render cost is
      // bounded by screen width, not history length
      const needCols = sp < 0.7 && i1 - i0 + 1 > plotRight * 1.5;
      const cols = needCols
        ? buildColumns(d, i0, i1, (i) => this._xFor(i), plotRight)
        : null;

      const scale = this._mainScale(i0, i1, cols);
      this._lastScale = scale;
      const { min, max, useLog } = scale;
      const main = ly.main;
      const tf = (p) => (useLog ? Math.log10(Math.max(p, 1e-12)) : p);
      const yOf = (p) =>
        clamp(main.y0 + ((max - tf(p)) / (max - min)) * main.h, main.y0 - 40, main.y1 + 40);
      const invY = (y) => {
        const t = max - ((y - main.y0) / main.h) * (max - min);
        return useLog ? Math.pow(10, t) : t;
      };

      /* ticks */
      const pticks = this._priceTicks(scale, main.h);
      const tticks = this._timeTicks(
        i0,
        i1,
        cols ? cols.map((c) => c.i1) : null
      );

      /* grid */
      ctx.strokeStyle = pal.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const t of pticks) {
        const y = Math.round(yOf(t)) + 0.5;
        if (y < main.y0 || y > main.y1) continue;
        ctx.moveTo(0, y);
        ctx.lineTo(plotRight, y);
      }
      for (const t of tticks) {
        const x = Math.round(t.x) + 0.5;
        if (x < 0 || x > plotRight) continue;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, plotBottom);
      }
      ctx.stroke();

      /* volatility-regime shading (behind everything but the grid) */
      if (this._volshade) {
        const vs = this._volShadeCache();
        if (vs) {
          const flushRun = (val, a, b) => {
            if (val !== 0 && val !== 2) return;
            const xa = clamp(this._xFor(a) - sp * 0.5, 0, plotRight);
            const xb = clamp(this._xFor(b) + sp * 0.5, 0, plotRight);
            if (xb <= xa) return;
            ctx.fillStyle = val === 0 ? hexToRgba(pal.accent, 0.05) : hexToRgba(pal.down, 0.07);
            ctx.fillRect(xa, main.y0, xb - xa, main.h);
          };
          let runVal = -2;
          let runA = i0;
          for (let i = i0; i <= i1; i++) {
            const rv = vs.regimes[i] == null ? -1 : vs.regimes[i];
            if (rv !== runVal) {
              flushRun(runVal, runA, i - 1);
              runVal = rv;
              runA = i;
            }
          }
          flushRun(runVal, runA, i1);
        }
      }

      /* server-side overlays: zones & levels (above regime shading, under series).
       * Zones with `to == null` extend into future space past the last bar. */
      if (this._overlays.length) {
        const d = this._data;
        const idxFor = (t, fallback) => (t == null ? fallback : barIndexForTime(d, t));
        for (const ov of this._overlays) {
          const col = resolveOverlayColor(ov.color, pal);
          if (ov.type === 'zone') {
            const iA = Math.max(0, idxFor(ov.from, 0));
            const iB = ov.to == null ? null : Math.max(0, idxFor(ov.to, d.length - 1));
            const zx0 = clamp(this._xFor(iA) - sp * 0.5, 0, plotRight);
            const zx1 = iB == null ? plotRight : clamp(this._xFor(iB) + sp * 0.5, 0, plotRight);
            const zyT = clamp(yOf(ov.priceTo), main.y0, main.y1);
            const zyB = clamp(yOf(ov.priceFrom), main.y0, main.y1);
            if (zx1 - zx0 < 1 || zyB - zyT < 1) continue;
            ctx.save();
            ctx.globalAlpha = ov.alpha;
            ctx.fillStyle = col;
            ctx.fillRect(zx0, zyT, zx1 - zx0, zyB - zyT);
            if (ov.border) {
              ctx.globalAlpha = Math.min(1, ov.alpha + 0.4);
              ctx.lineWidth = 1;
              ctx.strokeStyle = col;
              ctx.strokeRect(
                Math.round(zx0) + 0.5, Math.round(zyT) + 0.5,
                Math.max(2, Math.round(zx1 - zx0) - 1), Math.max(2, Math.round(zyB - zyT) - 1)
              );
            }
            if (ov.label) {
              ctx.globalAlpha = 0.95;
              ctx.font = pillFont();
              ctx.fillStyle = col;
              ctx.textAlign = 'left';
              ctx.textBaseline = 'top';
              ctx.fillText(ov.label, zx0 + 6, Math.max(main.y0, zyT) + 4);
            }
            ctx.restore();
          } else {
            const lx0 = clamp(this._xFor(Math.max(0, idxFor(ov.from, 0))) - sp * 0.5, 0, plotRight);
            const lx1 =
              ov.to == null
                ? plotRight
                : clamp(this._xFor(Math.max(0, idxFor(ov.to, d.length - 1))) + sp * 0.5, 0, plotRight);
            const ly = Math.round(yOf(ov.price)) + 0.5;
            if (lx1 - lx0 < 1 || ly < main.y0 || ly > main.y1) continue;
            ctx.save();
            ctx.strokeStyle = col;
            ctx.lineWidth = ov.width;
            if (ov.dash) ctx.setLineDash([5, 4]);
            ctx.beginPath();
            ctx.moveTo(lx0, ly);
            ctx.lineTo(lx1, ly);
            ctx.stroke();
            if (ov.label) {
              ctx.font = pillFont();
              ctx.fillStyle = col;
              ctx.textAlign = 'right';
              ctx.textBaseline = 'bottom';
              ctx.fillText(ov.label, Math.min(lx1, plotRight) - 6, ly - 2);
            }
            ctx.restore();
          }
        }
      }

      /* scenario projection: ghost path + σ-cone in future space (clipped to
       * the main plot so out-of-range bands never bleed into the axis) */
      if (this._scenario && d.length) {
        const sc = this._scenario;
        const col = resolveOverlayColor(sc.color, pal);
        const baseIdx = d.length - 1;
        const xAt = (h) => this._xFor(baseIdx + h);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, main.y0, plotRight, main.h);
        ctx.clip();
        if (sc.cone) {
          const cone = this._scenarioConeCache();
          if (cone) {
            for (let li = cone.levels.length - 1; li >= 0; li--) {
              const b = cone.bands[cone.levels[li]];
              ctx.globalAlpha = li === 0 ? 0.1 : 0.05;
              ctx.fillStyle = col;
              ctx.beginPath();
              ctx.moveTo(xAt(0), yOf(b.up[0]));
              for (let h = 1; h <= cone.horizon; h++) ctx.lineTo(xAt(h), yOf(b.up[h]));
              for (let h = cone.horizon; h >= 0; h--) ctx.lineTo(xAt(h), yOf(b.down[h]));
              ctx.closePath();
              ctx.fill();
            }
            const inner = cone.bands[cone.levels[0]];
            ctx.globalAlpha = 0.4;
            ctx.strokeStyle = col;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            for (const arr of [inner.up, inner.down]) {
              ctx.beginPath();
              ctx.moveTo(xAt(0), yOf(arr[0]));
              for (let h = 1; h <= cone.horizon; h++) ctx.lineTo(xAt(h), yOf(arr[h]));
              ctx.stroke();
            }
            ctx.setLineDash([]);
          }
        }
        if (sc.path.length) {
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(xAt(0), yOf(d[baseIdx].close));
          for (const p of sc.path) ctx.lineTo(xAt(p.h), yOf(p.price));
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = col;
          for (const p of sc.path) {
            const y = yOf(p.price);
            if (y >= main.y0 && y <= main.y1) {
              ctx.beginPath();
              ctx.arc(xAt(p.h), y, 2.5, 0, Math.PI * 2);
              ctx.fill();
            }
          }
          if (sc.label) {
            const p = sc.path[sc.path.length - 1];
            ctx.font = pillFont();
            ctx.globalAlpha = 0.95;
            ctx.fillStyle = col;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(
              sc.label,
              Math.min(xAt(p.h) + 8, plotRight - 4),
              clamp(yOf(p.price), main.y0 + 8, main.y1 - 8)
            );
          }
        }
        ctx.restore();
      }

      /* position zones (under series) */
      for (const pos of this._positions) {
        const yE = clamp(yOf(pos.entry), main.y0, main.y1);
        if (isNum(pos.target)) {
          const yT = clamp(yOf(pos.target), main.y0, main.y1);
          ctx.fillStyle = hexToRgba(pal.up, 0.07);
          ctx.fillRect(0, Math.min(yE, yT), plotRight, Math.abs(yT - yE));
        }
        if (isNum(pos.stop)) {
          const yS = clamp(yOf(pos.stop), main.y0, main.y1);
          ctx.fillStyle = hexToRgba(pal.down, 0.07);
          ctx.fillRect(0, Math.min(yE, yS), plotRight, Math.abs(yS - yE));
        }
      }

      /* risk plan: R-multiple grid — risk/reward shading + kR lines */
      if (this._riskPlan && d.length) {
        const rp = this._riskPlan;
        const fP = numberFmt(this._prec(scale.rawHi || 1));
        const yE = yOf(rp.entry);
        const yS = yOf(rp.stop);
        ctx.fillStyle = hexToRgba(pal.down, 0.06);
        ctx.fillRect(0, Math.min(yE, yS), plotRight, Math.abs(yS - yE));
        const yTop = yOf(rp.levels[rp.levels.length - 1].price);
        ctx.fillStyle = hexToRgba(pal.up, 0.05);
        ctx.fillRect(0, Math.min(yE, yTop), plotRight, Math.abs(yTop - yE));
        const line = (p, col, dash) => {
          const y = yOf(p);
          if (y < main.y0 || y > main.y1) return null;
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.5;
          if (dash) ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(0, Math.round(y) + 0.5);
          ctx.lineTo(plotRight, Math.round(y) + 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
          return y;
        };
        const pills = [];
        for (let i = rp.levels.length - 1; i >= 0; i--) {
          const lv = rp.levels[i];
          const y = line(lv.price, pal.up, true);
          if (y != null) {
            const kk = lv.k % 1 === 0 ? lv.k : +lv.k.toFixed(2);
            pills.push({ y, text: `${kk}R ${fP.format(lv.price)}`, bg: pal.up });
          }
        }
        const yStop = line(rp.stop, pal.down, false);
        if (yStop != null) pills.push({ y: yStop, text: `STOP ${fP.format(rp.stop)}`, bg: pal.down });
        const yEnt = line(rp.entry, pal.accent, false);
        if (yEnt != null) {
          pills.push({ y: yEnt, text: `${rp.direction === 'long' ? 'LONG' : 'SHORT'} ${fP.format(rp.entry)}`, bg: pal.accent });
        }
        // stack right-edge pills instead of letting close lines overlap
        pills.sort((a, b) => a.y - b.y);
        let lastY = -Infinity;
        for (const p of pills) {
          const y = Math.max(p.y, lastY + 20);
          lastY = y;
          ctx.font = pillFont();
          const tw = ctx.measureText(p.text).width + 12;
          this._pill(plotRight - tw - 8, y, p.text, p.bg, pal.pillText, 'left', tw);
        }
        if (rp.label) {
          ctx.font = pillFont();
          ctx.fillStyle = pal.accent;
          ctx.globalAlpha = 0.9;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(rp.label, 8, clamp(yE, main.y0 + 14, main.y1) - 3);
          ctx.globalAlpha = 1;
        }
      }

      /* volume profile (behind the series) */
      if (this._profile) {
        const pkey = `${i0}:${i1}:${this._version}`;
        if (this._profileKey !== pkey) {
          this._profileRes = computeVolumeProfile(d, i0, i1);
          this._profileKey = pkey;
        }
        const pr = this._profileRes;
        if (pr) {
          const fp = numberFmt(this._prec(scale.rawHi || 1));
          const maxW = plotRight * 0.18;
          for (let r = 0; r < pr.rows.length; r++) {
            const row = pr.rows[r];
            if (!row.v) continue;
            const yTop = yOf(pr.priceMin + (r + 1) * pr.rowH);
            const yBot = yOf(pr.priceMin + r * pr.rowH);
            const w = (row.v / pr.maxV) * maxW;
            const inVA = r >= pr.valIndex && r <= pr.vahIndex;
            ctx.globalAlpha = inVA ? 0.38 : 0.2;
            ctx.fillStyle = row.up >= row.dn ? pal.up : pal.down;
            ctx.fillRect(plotRight - w, yBot, w, Math.max(1, yTop - yBot - 0.5));
          }
          ctx.globalAlpha = 1;
          // POC
          ctx.strokeStyle = pal.accent;
          ctx.setLineDash([6, 4]);
          const yPoc = Math.round(yOf(pr.poc)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, yPoc);
          ctx.lineTo(plotRight, yPoc);
          ctx.stroke();
          // value area edges
          ctx.strokeStyle = pal.guide;
          ctx.beginPath();
          for (const [lv, y] of [
            [pr.vah, Math.round(yOf(pr.vah)) + 0.5],
            [pr.val, Math.round(yOf(pr.val)) + 0.5],
          ]) {
            void lv;
            ctx.moveTo(0, y);
            ctx.lineTo(plotRight, y);
          }
          ctx.stroke();
          ctx.setLineDash([]);
          // right-axis labels
          ctx.font = axisFont(600);
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = pal.accent;
          ctx.fillText(`POC ${fp.format(pr.poc)}`, W - 6, yPoc);
          ctx.fillStyle = pal.text;
          ctx.font = axisFont(500);
          ctx.fillText(`VAH ${fp.format(pr.vah)}`, W - 6, yOf(pr.vah));
          ctx.fillText(`VAL ${fp.format(pr.val)}`, W - 6, yOf(pr.val));
        }
      }

      /* smart annotations (skipped at deep zoom where bars collapse into columns) */
      if (this._annotations && !cols) {
        const akey = `${i0}:${i1}:${this._version}`;
        if (this._annoKey !== akey) {
          this._annoList = detectAnnotations(this._data, i0, i1, this._cachedRSI14());
          this._annoKey = akey;
          this._legendKey = ''; // legend may now show insights at the hovered bar
          this._fire('annotations', { annotations: this._annoList });
        }
        const A = this._annoList;
        if (A.length) {
          const BADGE_BG = {
            volspike: '#f0b429',
            gap: '#22d3ee',
            pivothigh: '#8b949e',
            pivotlow: '#8b949e',
            divbear: '#ea3943',
            divbull: '#16c784',
          };
          const BADGE_TXT = { volspike: 'V', gap: 'G', pivothigh: 'H', pivotlow: 'L', divbear: 'D', divbull: 'D' };
          for (const a of A) {
            const x = this._xFor(a.i);
            if (x < 10 || x > plotRight - 10) continue;
            const b = d[a.i];
            if (!b) continue;
            const y = a.side === 'high' ? yOf(b.high) - 9 : yOf(b.low) + 9;
            ctx.beginPath();
            ctx.arc(x, y, 6, 0, Math.PI * 2);
            ctx.fillStyle = BADGE_BG[a.type] || '#8b949e';
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = pal.bg && pal.bg !== 'transparent' ? pal.bg : '#0d1117';
            ctx.stroke();
            ctx.fillStyle = '#ffffff';
            ctx.font = `700 7.5px ${FONT_STACK}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(BADGE_TXT[a.type] || '?', x, y + 0.5);
          }
          ctx.lineWidth = 1;
        }
      }

      /* volume overlay */
      if (this._ind.volume) {
        let vmax = 0;
        if (cols) {
          for (const c of cols) if (c.volume > vmax) vmax = c.volume;
        } else {
          for (let i = i0; i <= i1; i++) if (d[i].volume > vmax) vmax = d[i].volume;
        }
        if (vmax > 0) {
          const bodyW = Math.max(1, Math.floor(sp * 0.7));
          const areaH = main.h * 0.2;
          ctx.globalAlpha = pal.volAlpha;
          if (cols) {
            for (const c of cols) {
              const h = (c.volume / vmax) * areaH;
              if (h <= 0) continue;
              ctx.fillStyle = c.close >= c.open ? pal.up : pal.down;
              ctx.fillRect(c.x, main.y1 - 1 - h, 1, h);
            }
          } else {
            // two passes by direction: fillStyle set twice instead of per bar
            for (let pass = 0; pass < 2; pass++) {
              ctx.fillStyle = pass === 0 ? pal.up : pal.down;
              for (let i = i0; i <= i1; i++) {
                const b = d[i];
                if ((b.close >= b.open) !== (pass === 0)) continue;
                const h = (b.volume / vmax) * areaH;
                if (h <= 0) continue;
                const x = this._xFor(i);
                ctx.fillRect(Math.round(x - bodyW / 2), main.y1 - 1 - h, bodyW, h);
              }
            }
          }
          ctx.globalAlpha = 1;
        }
      }

      /* series */
      const tStyle = this._type;
      if (tStyle === 'candles' || tStyle === 'hollow' || tStyle === 'bars' || tStyle === 'heikin') {
        if (cols) {
          // deep zoom: one hi-lo line per pixel column, colored by column direction
          for (let pass = 0; pass < 2; pass++) {
            ctx.strokeStyle = pass === 0 ? pal.up : pal.down;
            ctx.beginPath();
            for (const c of cols) {
              if ((c.close >= c.open) !== (pass === 0)) continue;
              const x = c.x + 0.5;
              ctx.moveTo(x, yOf(c.high));
              ctx.lineTo(x, yOf(c.low));
            }
            ctx.stroke();
          }
        } else {
        const bodyW = Math.max(1, Math.floor(sp * 0.7));
        const hollow = tStyle === 'hollow';
        const barsStyle = tStyle === 'bars';
        const tickLen = barsStyle ? Math.max(2, Math.floor(sp * 0.35)) : 0;
        // two passes (up/down): one wick path + one body batch per direction
        for (let pass = 0; pass < 2; pass++) {
          ctx.strokeStyle = pass === 0 ? pal.up : pal.down;
          ctx.fillStyle = ctx.strokeStyle;
          ctx.beginPath();
          for (let i = i0; i <= i1; i++) {
            const b = d[i];
            if ((b.close >= b.open) !== (pass === 0)) continue;
            const x = Math.round(this._xFor(i)) + 0.5;
            ctx.moveTo(x, yOf(b.high));
            ctx.lineTo(x, yOf(b.low));
            if (barsStyle && bodyW >= 3) {
              // OHLC ticks: open to the left, close to the right
              ctx.moveTo(x - tickLen, yOf(b.open));
              ctx.lineTo(x, yOf(b.open));
              ctx.moveTo(x, yOf(b.close));
              ctx.lineTo(x + tickLen, yOf(b.close));
            }
          }
          ctx.stroke();
          if (bodyW > 2 && !barsStyle) {
            const hollowPass = hollow && pass === 0; // up candles are outlined only
            for (let i = i0; i <= i1; i++) {
              const b = d[i];
              if ((b.close >= b.open) !== (pass === 0)) continue;
              const x = this._xFor(i);
              const yTop = yOf(Math.max(b.open, b.close));
              const yBot = yOf(Math.min(b.open, b.close));
              const h = Math.max(1, yBot - yTop);
              const bx = Math.round(x - bodyW / 2);
              if (hollowPass) {
                ctx.strokeRect(bx + 0.5, yTop + 0.5, Math.max(1, bodyW - 1), Math.max(1, h - 1));
              } else {
                ctx.fillRect(bx, yTop, bodyW, h);
              }
            }
          }
        }
        }
      } else {
        // line / area (column-sampled at deep zoom)
        const accent = pal.accent;
        const pts = [];
        if (cols) {
          for (const c of cols) pts.push([c.x, yOf(c.close)]);
        } else {
          for (let i = i0; i <= i1; i++) pts.push([this._xFor(i), yOf(d[i].close)]);
        }
        if (this._type === 'area') {
          const grad = ctx.createLinearGradient(0, main.y0, 0, main.y1);
          const c0 = hexToRgba(accent, 0.25);
          const c1 = hexToRgba(accent, 0.02);
          if (c0 !== accent || c1 !== accent) {
            grad.addColorStop(0, c0);
            grad.addColorStop(1, c1);
          } else {
            grad.addColorStop(0, accent);
            grad.addColorStop(1, accent);
          }
          ctx.globalAlpha = c0 !== accent ? 1 : 0.12;
          ctx.beginPath();
          ctx.moveTo(pts.length ? pts[0][0] : 0, pts.length ? pts[0][1] : main.y1);
          for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
          if (pts.length) {
            ctx.lineTo(pts[pts.length - 1][0], main.y1);
            ctx.lineTo(pts[0][0], main.y1);
          }
          ctx.closePath();
          ctx.fillStyle = grad;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.beginPath();
        for (let k = 0; k < pts.length; k++) {
          if (k === 0) ctx.moveTo(pts[k][0], pts[k][1]);
          else ctx.lineTo(pts[k][0], pts[k][1]);
        }
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.lineWidth = 1;
        // last point dot
        if (pts.length) {
          const [lx, lyv] = pts[pts.length - 1];
          if (lx >= -4 && lx <= plotRight + 4) {
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.arc(clamp(lx, 0, plotRight), clamp(lyv, main.y0, main.y1), 2.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      /* overlay indicators */
      this._ind.overlays.forEach((entry, idx) => {
        const res = this._indicatorSeries(entry);
        res.lines.forEach((ln, li) => {
          const s = ln.values;
          if (!s) return;
          const color = this._lineColor(entry, ln, pal, idx + li);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.lineJoin = 'round';
          ctx.beginPath();
          let started = false;
          if (cols) {
            for (const c of cols) {
              const val = s[c.i1];
              if (!isNum(val)) {
                started = false;
                continue;
              }
              if (!started) {
                ctx.moveTo(c.x, yOf(val));
                started = true;
              } else ctx.lineTo(c.x, yOf(val));
            }
          } else {
            for (let i = i0; i <= i1; i++) {
              const val = s[i];
              if (!isNum(val)) {
                started = false;
                continue;
              }
              const x = this._xFor(i);
              const y = yOf(val);
              if (!started) {
                ctx.moveTo(x, y);
                started = true;
              } else ctx.lineTo(x, y);
            }
          }
          ctx.stroke();
        });
        ctx.lineWidth = 1;
      });

      /* session / data-gap dividers */
      {
        const gaps = detectGaps(d, i0, i1, this._dt, 3);
        if (gaps.length) {
          ctx.save();
          ctx.strokeStyle = pal.crosshair;
          ctx.globalAlpha = 0.55;
          ctx.setLineDash([2, 4]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (const gi of gaps) {
            const x =
              Math.round((this._xFor(gi - 1) + this._xFor(gi)) / 2) + 0.5;
            if (x < 0 || x > plotRight) continue;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, plotBottom);
          }
          ctx.stroke();
          ctx.restore();
        }
      }

      /* position lines, tags & price alerts */
      if (this._positions.length || this._alerts.length) {
        const fP = numberFmt(this._prec(scale.rawHi || 1));

        // alerts: dashed lines + diamond marker at the right edge
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = pal.overlay[0];
        for (const a of this._alerts) {
          if (a.fired || !isNum(a.price)) continue; // scripted alerts have no line
          const y = yOf(a.price);
          if (y < main.y0 || y > main.y1) continue;
          ctx.globalAlpha = 0.8;
          ctx.beginPath();
          ctx.moveTo(0, Math.round(y) + 0.5);
          ctx.lineTo(plotRight, Math.round(y) + 0.5);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = pal.overlay[0];
          const mx = plotRight - 7;
          ctx.beginPath();
          ctx.moveTo(mx, y - 4);
          ctx.lineTo(mx + 4, y);
          ctx.lineTo(mx, y + 4);
          ctx.lineTo(mx - 4, y);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();

        for (const pos of this._positions) {
          const yE = clamp(yOf(pos.entry), main.y0, main.y1);
          ctx.strokeStyle = pal.accent;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(0, Math.round(yE) + 0.5);
          ctx.lineTo(plotRight, Math.round(yE) + 0.5);
          ctx.stroke();
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          for (const [lv, col] of [
            [pos.stop, pal.down],
            [pos.target, pal.up],
          ]) {
            if (!isNum(lv)) continue;
            const y = clamp(yOf(lv), main.y0, main.y1);
            ctx.strokeStyle = col;
            ctx.beginPath();
            ctx.moveTo(0, Math.round(y) + 0.5);
            ctx.lineTo(plotRight, Math.round(y) + 0.5);
            ctx.stroke();
          }
          ctx.setLineDash([]);
          const tag = `${pos.side === 'short' ? 'S' : 'L'} ${fP.format(pos.entry)}`;
          ctx.font = pillFont();
          const tw = ctx.measureText(tag).width + 10;
          this._pill(plotRight - tw - 8, yE, tag, pal.accent, pal.pillText, 'left', tw);
        }
      }

      /* indicator panes */
      for (const pr of ly.panes) {
        const entry = pr.entry;
        const res = this._indicatorSeries(entry);
        if (!res.lines.length && !res.histogram) continue;
        const fmtV = (v) =>
          entry.def.fmt === 'fixed1'
            ? numberFmt(1).format(v)
            : entry.def.fmt === 'compact'
            ? fmtCompact(v)
            : numberFmt(this._prec(scale.rawHi || 1)).format(v);

        // pane scale (fixed range or autoscaled from visible values)
        let pmin = Infinity;
        let pmax = -Infinity;
        if (Array.isArray(entry.def.range) && entry.def.range.length === 2) {
          pmin = entry.def.range[0];
          pmax = entry.def.range[1];
        } else {
          const scan = (arr) => {
            for (let i = i0; i <= i1; i++) {
              const v = arr[i];
              if (isNum(v)) {
                if (v < pmin) pmin = v;
                if (v > pmax) pmax = v;
              }
            }
          };
          for (const ln of res.lines) scan(ln.values);
          if (res.histogram) scan(res.histogram);
          if (!isFinite(pmin) || !isFinite(pmax)) {
            pmin = 0;
            pmax = 1;
          }
          if (pmax === pmin) {
            const e = Math.abs(pmax) * 0.05 || 1;
            pmax += e;
            pmin -= e;
          }
          const pad = (pmax - pmin) * 0.08;
          pmin -= pad;
          pmax += pad;
        }
        const pyOf = (v) => pr.y0 + 5 + ((pmax - v) / (pmax - pmin)) * (pr.h - 10);
        const invPy = (y) => pmax - ((y - pr.y0 - 5) / (pr.h - 10)) * (pmax - pmin);
        pr.pyOf = pyOf;
        pr.invPy = invPy;

        ctx.save();
        // guides
        ctx.strokeStyle = pal.guide;
        ctx.setLineDash([3, 4]);
        for (const g of entry.def.guides || []) {
          const y = Math.round(pyOf(g)) + 0.5;
          if (y < pr.y0 || y > pr.y1) continue;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(plotRight, y);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        // histogram (e.g. MACD)
        if (res.histogram) {
          const bodyW = Math.max(1, Math.floor(sp * 0.55));
          const y0 = clamp(pyOf(0), pr.y0, pr.y1);
          ctx.globalAlpha = 0.55;
          if (cols) {
            for (const c of cols) {
              const val = res.histogram[c.i1];
              if (!isNum(val)) continue;
              ctx.fillStyle = val >= 0 ? pal.up : pal.down;
              const y = pyOf(val);
              ctx.fillRect(c.x, Math.min(y, y0), 1, Math.max(1, Math.abs(y - y0)));
            }
          } else {
          for (let pass = 0; pass < 2; pass++) {
            ctx.fillStyle = pass === 0 ? pal.up : pal.down;
            for (let i = i0; i <= i1; i++) {
              const v = res.histogram[i];
              if (!isNum(v)) continue;
              if ((v >= 0) !== (pass === 0)) continue;
              const y = pyOf(v);
              const x = this._xFor(i);
              ctx.fillRect(
                Math.round(x - bodyW / 2),
                Math.min(y, y0),
                bodyW,
                Math.max(1, Math.abs(y - y0))
              );
            }
          }
          }
          ctx.globalAlpha = 1;
        }

        // lines
        res.lines.forEach((ln, li) => {
          const color = this._lineColor(entry, ln, pal, li);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.lineJoin = 'round';
          ctx.beginPath();
          let started = false;
          const plot = (x, val) => {
            if (!started) {
              ctx.moveTo(x, pyOf(val));
              started = true;
            } else ctx.lineTo(x, pyOf(val));
          };
          if (cols) {
            for (const c of cols) {
              const val = ln.values[c.i1];
              if (!isNum(val)) {
                started = false;
                continue;
              }
              plot(c.x, val);
            }
          } else {
            for (let i = i0; i <= i1; i++) {
              const val = ln.values[i];
              if (!isNum(val)) {
                started = false;
                continue;
              }
              plot(this._xFor(i), val);
            }
          }
          ctx.stroke();
        });
        ctx.lineWidth = 1;
        ctx.restore();

        // right-axis labels: guide levels, or the pane's own min/max when
        // an autoscaled pane has no guides (atr / obv / pexpr)
        ctx.font = axisFont(400);
        ctx.fillStyle = pal.text;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        if ((entry.def.guides || []).length) {
          for (const g of entry.def.guides) {
            ctx.fillText(fmtV(g), W - 6, pyOf(g));
          }
        } else {
          ctx.fillText(fmtV(pmax), W - 6, pyOf(pmax) + 6);
          if (pmax !== pmin) ctx.fillText(fmtV(pmin), W - 6, pyOf(pmin) - 6);
        }

        // pane label + live values (script panes show their expression label)
        const hi = this._hover ? clamp(this._hover.index, 0, d.length - 1) : d.length - 1;
        const vals = res.lines
          .map((ln) => (isNum(ln.values[hi]) ? fmtV(ln.values[hi]) : '—'))
          .join('  ');
        const paneLabel =
          (entry.name === 'expr' || entry.name === 'pexpr') && res.lines[0] && res.lines[0].name
            ? res.lines[0].name
            : `${entry.name.toUpperCase()} ${Object.values(entry.params).join(' ')}`;
        ctx.font = axisFont(600);
        ctx.fillStyle = pal.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.globalAlpha = 0.9;
        ctx.fillText(`${paneLabel}${vals ? '   ' + vals : ''}`, 8, pr.y0 + 5);
        ctx.globalAlpha = 1;
      }

      /* pane separators & axis borders */
      ctx.strokeStyle = pal.border;
      ctx.beginPath();
      for (const pr of ly.panes) {
        const y = Math.round(pr.y0) - 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      }
      ctx.moveTo(Math.round(plotRight) + 0.5, 0);
      ctx.lineTo(Math.round(plotRight) + 0.5, plotBottom);
      ctx.moveTo(0, Math.round(plotBottom) + 0.5);
      ctx.lineTo(W, Math.round(plotBottom) + 0.5);
      ctx.stroke();

      /* axis labels */
      const f = numberFmt(this._prec(scale.rawHi || 1));
      ctx.font = axisFont();
      ctx.fillStyle = pal.text;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const t of pticks) {
        const y = yOf(t);
        if (y < main.y0 + 7 || y > main.y1 - 5) continue;
        ctx.fillText(f.format(t), W - 6, y);
      }
      ctx.textAlign = 'center';
      for (const t of tticks) {
        if (t.x < 10 || t.x > plotRight - 10) continue;
        ctx.fillText(t.label, t.x, plotBottom + 13);
      }

      /* last price line + pill */
      const lastBar = d[d.length - 1];
      const prevBar = d[d.length - 2] || lastBar;
      const lastY = clamp(yOf(lastBar.close), main.y0 + 9, main.y1 - 9);
      const lastUp = lastBar.close >= prevBar.close;
      if (lastY > main.y0 && lastY < main.y1) {
        ctx.save();
        ctx.strokeStyle = lastUp ? pal.up : pal.down;
        ctx.globalAlpha = 0.7;
        ctx.setLineDash([1, 3]);
        ctx.beginPath();
        ctx.moveTo(0, Math.round(lastY) + 0.5);
        ctx.lineTo(plotRight, Math.round(lastY) + 0.5);
        ctx.stroke();
        ctx.restore();
        this._pill(
          plotRight + 2,
          lastY,
          f.format(lastBar.close),
          lastUp ? pal.up : pal.down,
          pal.pillText,
          'left'
        );
      }

      /* plugin layers — above chart content, under the pointer-following UI */
      if (this._layers.length) this._drawLayers(ctx, pal, ly, d);

      /* crosshair */
      if (this._hover && this._hover.index < d.length) {
        const h = this._hover;
        const hx = this._xFor(h.index);
        ctx.save();
        ctx.strokeStyle = pal.crosshair;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        const cx = Math.round(hx) + 0.5;
        if (cx >= 0 && cx <= plotRight) {
          ctx.moveTo(cx, 0);
          ctx.lineTo(cx, plotBottom);
        }
        const inMain = h.y <= main.y1;
        const paneUnder = inMain
          ? null
          : ly.panes.find((p) => h.y >= p.y0 && h.y <= p.y1);
        if (inMain || paneUnder) {
          const hy = Math.round(h.y) + 0.5;
          ctx.moveTo(0, hy);
          ctx.lineTo(plotRight, hy);
        }
        ctx.stroke();
        ctx.restore();

        // price pill
        if (inMain) {
          this._pill(
            plotRight + 2,
            h.y,
            f.format(invY(h.y)),
            pal.crosshairBg,
            pal.crosshairText,
            'left'
          );
        } else if (paneUnder) {
          const fmtV =
            paneUnder.entry.def.fmt === 'fixed1'
              ? (v) => v.toFixed(1)
              : paneUnder.entry.def.fmt === 'compact'
              ? (v) => fmtCompact(v)
              : (v) => f.format(v);
          this._pill(
            plotRight + 2,
            h.y,
            fmtV(paneUnder.invPy(h.y)),
            pal.crosshairBg,
            pal.crosshairText,
            'left'
          );
        }

        // time pill
        const tLabel = fmtFull(this._zt(d[h.index].time));
        ctx.font = pillFont();
        const tw = ctx.measureText(tLabel).width + 12;
        this._pill(
          clamp(hx - tw / 2, 2, plotRight - tw - 2),
          plotBottom + 2,
          tLabel,
          pal.crosshairBg,
          pal.crosshairText,
          'left',
          tw
        );
      }

      /* co-view presence: peer viewport bands along the top of the plot */
      if (this._presence && this._presence.peers.size && d.length) {
        const peers = this._presence.list().slice(0, 4);
        ctx.save();
        ctx.font = pillFont();
        for (let row = 0; row < peers.length; row++) {
          const p = peers[row];
          if (!p.range) continue;
          const cols = pal.overlay || [];
          const col = cols[(row + 1) % Math.max(cols.length, 1)] || pal.accent;
          const i0 = WickChart._indexForTime(this._data, p.range.from);
          const i1 = WickChart._indexForTime(this._data, p.range.to);
          const x0 = clamp(this._xFor(i0), 0, plotRight);
          const x1 = clamp(this._xFor(i1), 0, plotRight);
          const y = main.y0 + 2 + row * 5;
          ctx.globalAlpha = 0.8;
          ctx.fillStyle = col;
          ctx.fillRect(x0, y, Math.max(x1 - x0, 3), 3);
          if (x1 - x0 > 44) {
            ctx.globalAlpha = 0.95;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(p.name || p.id, x0 + 3, y + 4);
          }
        }
        ctx.restore();
      }

      /* co-view ghost crosshair (peer pointer from another tab/chart) */
      if (this._ghost) {
        const g = this._ghost;
        const gx = this._xFor(g.index);
        const gxVisible = gx >= 0 && gx <= plotRight;
        ctx.save();
        ctx.strokeStyle = pal.accent;
        ctx.globalAlpha = 0.7;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        if (gxVisible) {
          const cx = Math.round(gx) + 0.5;
          ctx.moveTo(cx, 0);
          ctx.lineTo(cx, plotBottom);
        }
        if (g.yFrac != null) {
          const gy = Math.round(main.y0 + g.yFrac * main.h) + 0.5;
          ctx.moveTo(0, gy);
          ctx.lineTo(plotRight, gy);
          if (gxVisible) {
            ctx.fillStyle = pal.accent;
            ctx.beginPath();
            ctx.arc(gx, main.y0 + g.yFrac * main.h, 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.stroke();
        ctx.restore();
        if (gxVisible && this._data[g.index]) {
          const tLabel = fmtFull(this._zt(this._data[g.index].time));
          ctx.font = pillFont();
          const tw = ctx.measureText(tLabel).width + 12;
          this._pill(
            clamp(gx - tw / 2, 2, plotRight - tw - 2),
            plotBottom + 2,
            tLabel,
            pal.accent,
            pal.pillText,
            'left',
            tw
          );
        }
      }

      /* measure tool overlay */
      if (this._measure && this._measure.pA != null && this._measure.pB != null) {
        const m = this._measure;
        const xa = this._xFor(m.iA);
        const xb = this._xFor(m.iB);
        const ya = clamp(yOf(m.pA), main.y0, main.y1);
        const yb = clamp(yOf(m.pB), main.y0, main.y1);
        const rx0 = Math.min(xa, xb);
        const rx1 = Math.max(xa, xb);
        const ry0 = Math.min(ya, yb);
        const ry1 = Math.max(ya, yb);
        if (rx1 - rx0 > 2 && ry1 - ry0 > 2) {
          ctx.save();
          ctx.fillStyle = hexToRgba(pal.accent, 0.06);
          ctx.fillRect(rx0, ry0, rx1 - rx0, ry1 - ry0);
          ctx.strokeStyle = pal.crosshair;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(Math.round(rx0) + 0.5, Math.round(ry0) + 0.5, rx1 - rx0, ry1 - ry0);
          ctx.restore();
        }
        const barsN = Math.abs(m.iB - m.iA);
        const ms = Math.abs((d[m.iB] ? d[m.iB].time : 0) - (d[m.iA] ? d[m.iA].time : 0));
        const hrs = Math.floor(ms / 3600e3);
        const dP = m.pB - m.pA;
        const dPct = m.pA ? (dP / m.pA) * 100 : 0;
        const label =
          `${dP >= 0 ? '+' : ''}${f.format(dP)} (${dPct >= 0 ? '+' : ''}${dPct.toFixed(2)}%)` +
          ` · ${barsN} bars` +
          ` · ${hrs >= 24 ? Math.floor(hrs / 24) + 'd ' + (hrs % 24) + 'h' : hrs + 'h'}`;
        ctx.font = pillFont();
        const tw = ctx.measureText(label).width + 14;
        this._pill(
          clamp((rx0 + rx1) / 2 - tw / 2, 2, plotRight - tw - 2),
          clamp((ry0 + ry1) / 2, 10, plotBottom - 10),
          label,
          pal.crosshairBg,
          pal.crosshairText,
          'left',
          tw
        );
      }

      /* delta brush selection: band + live delta chip */
      {
        const sel = this._brushDrag || this._brushSel;
        if (sel && d.length) {
          const bi0 = Math.min(sel.i0, sel.i1);
          const bi1 = Math.max(sel.i0, sel.i1);
          const xa = this._xFor(bi0) - this._view.spacing / 2;
          const xb = this._xFor(bi1) + this._view.spacing / 2;
          const bx0 = clamp(Math.min(xa, xb), 0, plotRight);
          const bx1 = clamp(Math.max(xa, xb), 0, plotRight);
          if (bx1 - bx0 > 1) {
            const live = this._brushDrag ? brushStats(this._data, bi0, bi1) : sel.stats;
            ctx.save();
            ctx.fillStyle = hexToRgba(pal.accent, this._brushDrag ? 0.13 : 0.08);
            ctx.fillRect(bx0, main.y0, bx1 - bx0, main.h);
            ctx.globalAlpha = 0.55;
            ctx.strokeStyle = pal.accent;
            ctx.lineWidth = 1;
            if (!this._brushDrag) ctx.setLineDash([4, 3]);
            ctx.strokeRect(bx0 + 0.5, main.y0 + 0.5, bx1 - bx0 - 1, main.h - 1);
            ctx.setLineDash([]);
            ctx.restore();
            if (live) {
              const fP = numberFmt(this._prec(Math.abs(live.lastClose) || 1));
              const sign = live.delta >= 0 ? '+' : '';
              const txt =
                `${sign}${live.deltaPct.toFixed(2)}% · ${live.bars} bars · ` +
                `H ${fP.format(live.high)} · L ${fP.format(live.low)} · Σvol ${fmtCompact(live.volume)}`;
              ctx.font = pillFont();
              const tw = ctx.measureText(txt).width + 12;
              this._pill(
                clamp((bx0 + bx1) / 2 - tw / 2, 2, plotRight - tw - 2),
                main.y0 + 11,
                txt,
                live.delta >= 0 ? pal.up : pal.down,
                pal.pillText,
                'left',
                tw
              );
            }
          }
        }
      }

      /* visible-range stats chip */
      if (this._stats) {
        const st = computeStats(d, i0, i1, this._dt);
        const skey = st ? `${i0}:${i1}:${this._version}` : 'none';
        if (skey !== this._statsKey) {
          this._statsKey = skey;
          if (st) {
            const pct = (v, dgt = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(dgt)}%`;
            this._statsRow.innerHTML =
              `<span><b>${pct(st.changePct)}</b></span>` +
              `<span>maxDD ${st.maxDDPct.toFixed(1)}%</span>` +
              `<span>ann.vol ${st.annVolPct.toFixed(0)}%</span>` +
              `<span>up ${st.up} / dn ${st.dn}</span>` +
              `<span>vol ${fmtCompact(st.avgVolume)}</span>`;
          } else {
            this._statsRow.innerHTML = '';
          }
        }
      } else if (this._statsRow.innerHTML) {
        this._statsRow.innerHTML = '';
        this._statsKey = '';
      }

      this._updateLegend();
    }

    _pill(x, y, text, bg, fg, align = 'left', widthOverride) {
      const ctx = this._ctx;
      ctx.save();
      ctx.font = pillFont();
      const tw = widthOverride || ctx.measureText(text).width + 12;
      const th = 18;
      const yy = clamp(y - th / 2, 0, this._H - th);
      ctx.fillStyle = bg;
      roundRectPath(ctx, x, yy, tw, th, 4);
      ctx.fill();
      ctx.fillStyle = fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + tw / 2, yy + th / 2 + 0.5);
      ctx.restore();
    }

    _updateLegend() {
      const d = this._renderBars();
      if (!d.length) {
        this._legend.innerHTML = '';
        return;
      }
      const hoverIdx = this._hover ? this._hover.index : d.length - 1;
      const idx = clamp(hoverIdx, 0, d.length - 1);
      const key = [
        idx, this._version, this._type, this._label, this._theme,
        this.getAttribute('indicators'), this.getAttribute('volshading'),
        this._positions.length, this._posVersion || 0,
      ].join('|');
      if (key === this._legendKey) return;
      this._legendKey = key;

      const b = d[idx];
      const p = this._prec(b.close);
      const f = numberFmt(p);
      const pct = b.open ? ((b.close - b.open) / b.open) * 100 : 0;
      const up = b.close >= b.open;
      const cls = up ? 'up' : 'dn';
      const sign = pct >= 0 ? '+' : '';

      const esc = (s) =>
        String(s).replace(/[&<>"']/g, (c) =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
        );

      let html = `<div class="row"><span class="sym">${esc(this._label || '')}</span>`;
      if (this._type === 'candles') {
        html +=
          `<span class="kv"><span class="k">O</span><span class="v">${f.format(b.open)}</span></span>` +
          `<span class="kv"><span class="k">H</span><span class="v">${f.format(b.high)}</span></span>` +
          `<span class="kv"><span class="k">L</span><span class="v">${f.format(b.low)}</span></span>`;
      }
      html += `<span class="kv"><span class="k">C</span><span class="v ${cls}">${f.format(b.close)}</span></span>`;
      html += `<span class="pct ${cls}">${sign}${pct.toFixed(2)}%</span>`;
      if (b.volume > 0 || this._ind.volume) {
        html += `<span class="kv"><span class="k">Vol</span><span class="v">${fmtCompact(b.volume)}</span></span>`;
      }
      html += `</div>`;

      const palNow = this._palette();
      this._ind.overlays.forEach((entry, i) => {
        const res = this._indicatorSeries(entry);
        if (!res.lines.length) return;
        const dotColor = this._lineColor(entry, res.lines[0], palNow, i);
        const vals = res.lines
          .map((ln) => (isNum(ln.values[idx]) ? f.format(ln.values[idx]) : '—'))
          .join('  ');
        // script indicators carry their expression in the line name; built-ins show name+params
        const label =
          (entry.name === 'expr' || entry.name === 'pexpr') && res.lines[0].name
            ? esc(res.lines[0].name)
            : `${entry.name.toUpperCase()} ${Object.values(entry.params).join(' ')}`;
        html += `<div class="row"><span class="ind"><i style="background:${dotColor}"></i>${label}</span><span class="v">${vals}</span></div>`;
      });

      if (this._volshade) {
        const vs = this._volShadeCache();
        const rv = vs ? vs.regimes[idx] : -1;
        if (vs && rv >= 0) {
          const pct = percentileOfSorted(vs.sorted, vs.vol[idx]);
          const name = rv === 0 ? 'calm' : rv === 2 ? 'hot' : 'normal';
          const dot = rv === 0 ? palNow.accent : rv === 2 ? palNow.down : palNow.text;
          html +=
            `<div class="row"><span class="ind">` +
            `<i style="background:${dot}"></i>VOL ${this._volshade.p1}/${this._volshade.p2} · ${name}` +
            `${isNum(pct) ? ` · ${pct.toFixed(0)}%ile` : ''}` +
            `</span></div>`;
        }
      }

      if (this._annotations && this._annoList) {
        const notes = this._annoList.filter((a) => a.i === idx).map((a) => a.note);
        if (notes.length) {
          html += `<div class="row"><span class="insight">${notes.map(esc).join(' · ')}</span></div>`;
        }
      }

      this._legend.innerHTML = html;
      this._updateHud();
    }

    /** Position P&L chips (top-right HTML overlay). */
    _updateHud() {
      const poss = this._poss;
      if (!this._positions.length) {
        if (poss.innerHTML) poss.innerHTML = '';
        return;
      }
      const d = this._data;
      const price = d.length ? d[d.length - 1].close : NaN;
      const f = numberFmt(this._prec(price || 1));
      const esc = (s) =>
        String(s).replace(/[&<>"']/g, (c) =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
        );
      let html = '';
      for (const p of this._positions) {
        const pnl = positionPnl(p, price);
        const pct = positionPnlPct(p, price);
        const cls = pnl >= 0 ? 'up' : 'dn';
        const qtyStr = p.qty != null ? ' ' + p.qty : '';
        html +=
          `<div class="pos">` +
          `<span class="k">${esc(p.side === 'short' ? 'SHORT' : 'LONG')}${esc(qtyStr)} @ ${f.format(p.entry)}</span>` +
          `<span class="v ${cls}">${pnl >= 0 ? '+' : ''}${f.format(pnl)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>` +
          `</div>`;
      }
      poss.innerHTML = html;
    }

    /* ------------------------------------------------------------ *
     * Plugin layers — external draw hooks + pointer claims
     * ------------------------------------------------------------ */

    /**
     * Register a plugin layer. `layer.draw(api)` runs on every render, above
     * chart content and under the crosshair; `layer.onPointer(pev)` is asked
     * first on pointerdown and claims the gesture by returning true — the
     * layer then receives that pointer's move/up/cancel events (plus a
     * 'cancel' on Escape) and the chart suppresses its own pan/measure/brush
     * for the duration.
     *
     * A layer may also declare `insetBottom` (px, 0..160): the largest
     * declared inset reserves a docked strip at the very bottom of the
     * canvas — all chart content (panes + time axis) shrinks above it and
     * the strip is handed to layers as `api.layout.dock = { y0, h }`
     * (used by the wickchart-navigator plugin).
     * @param {{id?: string, draw: Function, onPointer?: Function, insetBottom?: number}} layer
     * @returns {object|null} the normalized layer handle (with `id`), or null
     *   if the layer was rejected (no draw fn, or 16 layers already added)
     */
    addLayer(layer) {
      if (!layer || typeof layer !== 'object' || typeof layer.draw !== 'function') return null;
      if (this._layers.length >= 16) return null;
      const id =
        layer.id != null && String(layer.id).trim()
          ? String(layer.id).slice(0, 64)
          : 'layer-' + ++this._layerSeq;
      const entry = {
        id,
        draw: layer.draw,
        insetBottom:
          typeof layer.insetBottom === 'number' && Number.isFinite(layer.insetBottom)
            ? Math.max(0, Math.min(160, Math.round(layer.insetBottom)))
            : 0,
        onPointer: typeof layer.onPointer === 'function' ? layer.onPointer : null,
      };
      const at = this._layers.findIndex((l) => l.id === id);
      if (at >= 0) this._layers[at] = entry; // same id replaces
      else this._layers.push(entry);
      this._invalidate();
      return entry;
    }

    /**
     * Remove a layer added via addLayer (pass the returned handle or its id).
     * @param {object|string} idOrLayer
     * @returns {boolean} true if a layer was removed
     */
    removeLayer(idOrLayer) {
      const id = idOrLayer != null && typeof idOrLayer === 'object' ? idOrLayer.id : idOrLayer;
      if (id == null) return false;
      const at = this._layers.findIndex((l) => l.id === String(id));
      if (at < 0) return false;
      const [gone] = this._layers.splice(at, 1);
      if (this._layerClaim && this._layerClaim.layer === gone) this._layerClaim = null;
      this._invalidate();
      return true;
    }

    /** Ask for a repaint on the next frame (interactive layers call this). */
    requestDraw() {
      this._invalidate();
    }

    /** Paint every registered layer. Called from _render with live state. */
    _drawLayers(ctx, pal, ly, d) {
      for (const layer of this._layers) {
        try {
          layer.draw({
            ctx, // 2D context, already DPR-scaled — draw in CSS pixels
            layout: ly,
            palette: pal,
            data: d,
            view: this._view,
            timeToX: (t) => this.timeToX(t),
            xToTime: (x) => this.xToTime(x),
            priceToY: (p) => this.priceToY(p),
            yToPrice: (y) => this.yToPrice(y),
          });
        } catch (err) {
          console.warn('wick-chart: layer "' + layer.id + '" threw in draw', err);
        }
      }
    }

    /**
     * Bottom space reserved by plugin layers: the largest declared
     * `insetBottom` (px, clamped 0..160 at addLayer time), or 0.
     */
    _dockInset() {
      let dock = 0;
      for (const l of this._layers) {
        if (l.insetBottom > dock) dock = l.insetBottom;
      }
      return dock;
    }

    /** Ask layers, in order, whether one claims this pointerdown. */
    _layerHit(e, pt) {
      for (const layer of this._layers) {
        if (!layer.onPointer) continue;
        let claimed = false;
        try {
          claimed = layer.onPointer(this._layerPointerEvent(e, pt, 'down')) === true;
        } catch (err) {
          console.warn('wick-chart: layer "' + layer.id + '" threw in onPointer', err);
        }
        if (claimed) return layer;
      }
      return null;
    }

    /** Deliver a pointer event to a claiming layer; never throws outward. */
    _routeLayer(layer, e, pt, type) {
      const ev = pt
        ? this._layerPointerEvent(e, pt, type)
        : {
            type,
            x: null,
            y: null,
            pointerId: e.pointerId == null ? 0 : e.pointerId,
            button: 0,
            shiftKey: !!e.shiftKey,
            ctrlKey: !!e.ctrlKey,
            altKey: !!e.altKey,
            metaKey: !!e.metaKey,
          };
      try {
        if (layer.onPointer) layer.onPointer(ev);
      } catch (err) {
        console.warn('wick-chart: layer "' + layer.id + '" threw in onPointer', err);
      }
    }

    _layerPointerEvent(e, pt, type) {
      return {
        type,
        x: pt.x,
        y: pt.y,
        pointerId: e.pointerId,
        button: e.button == null ? 0 : e.button,
        shiftKey: !!e.shiftKey,
        ctrlKey: !!e.ctrlKey,
        altKey: !!e.altKey,
        metaKey: !!e.metaKey,
      };
    }

    /**
     * x-pixel for a bar time (ms or s, auto-detected). Extrapolates past the
     * last bar into future space using the median bar interval, so layers can
     * anchor trendlines to tomorrow, not just to history.
     * @param {number} time
     * @returns {number|null}
     */
    timeToX(time) {
      const ly = this._ly;
      const d = this._data;
      if (!ly || !d.length || !isNum(time)) return null;
      const t = toMs(time);
      const last = d.length - 1;
      if (t >= d[last].time) {
        return this._xFor(last + (t - d[last].time) / (this._dt || HOUR));
      }
      const i = WickChart._indexForTime(d, t);
      if (i === 0 && t < d[0].time) {
        return this._xFor((t - d[0].time) / (this._dt || HOUR));
      }
      if (i > 0 && t < d[i].time) {
        // between two bars: fractional index
        const a = d[i - 1];
        const b = d[i];
        return this._xFor(i - 1 + (t - a.time) / (b.time - a.time || 1));
      }
      return this._xFor(i);
    }

    /**
     * Bar time (ms) at an x-pixel — the inverse of timeToX, interpolating
     * between bars and extrapolating beyond both data edges.
     * @param {number} x
     * @returns {number|null}
     */
    xToTime(x) {
      const ly = this._ly;
      const d = this._data;
      if (!ly || !d.length || !isNum(x)) return null;
      const idx = this._indexForX(x);
      const last = d.length - 1;
      if (idx >= last) return d[last].time + (idx - last) * (this._dt || HOUR);
      if (idx <= 0) return d[0].time + idx * (this._dt || HOUR);
      const i0 = Math.floor(idx);
      const a = d[i0];
      const b = d[Math.min(i0 + 1, last)];
      return a.time + (b.time - a.time) * (idx - i0);
    }

    /**
     * y-pixel for a price in the main pane (current scale; log-aware).
     * Unclamped — values off-screen still map, layers decide how to clip.
     * @param {number} price
     * @returns {number|null}
     */
    priceToY(price) {
      const ly = this._ly;
      const scale = this._lastScale;
      if (!ly || !scale || !isNum(price)) return null;
      const { min, max, useLog } = scale;
      const v = useLog ? Math.log10(Math.max(price, 1e-12)) : price;
      return ly.main.y0 + ((max - v) / (max - min)) * ly.main.h;
    }

    /**
     * Price at a y-pixel in the main pane — the inverse of priceToY.
     * @param {number} y
     * @returns {number|null}
     */
    yToPrice(y) {
      if (!isNum(y)) return null;
      return this._yToPrice(y);
    }

    /* ------------------------------------------------------------ *
     * Interaction
     * ------------------------------------------------------------ */

    _localPoint(e) {
      const r = this._canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    /**
     * Put the crosshair on the bar under a point and announce it. Shared by
     * mouse hover, keyboard walking and the touch scrub gesture.
     */
    _hoverAt(pt) {
      if (!this._ly || !this._data.length) return;
      const idx = clamp(Math.round(this._indexForX(pt.x)), 0, this._data.length - 1);
      this._hover = { index: idx, x: this._xFor(idx), y: pt.y };
      this._maybeSonify(idx);
      this._emitCrosshair(this._hover);
      this._invalidate();
    }

    /**
     * Start the long-press timer for a touch. A touchscreen has no hover, so
     * without this there is no way to read a bar's values on a phone: a tap
     * selects, a drag pans, and the legend never leaves the last candle.
     * Holding still opens the crosshair; moving first cancels and pans.
     */
    _armPress(pointerId, pt) {
      this._disarmPress();
      this._pressOrigin = { pointerId, x: pt.x, y: pt.y };
      this._pressTimer = setTimeout(() => {
        this._pressTimer = 0;
        const origin = this._pressOrigin;
        // Still one finger, still down, nothing else has claimed the gesture.
        if (!origin || this._pointers.size !== 1 || this._layerClaim) return;
        if (!this._pointers.has(origin.pointerId)) return;
        this._scrub = true;
        this._pan = null;
        this._measuring = false;
        this._canvas.classList.remove('grabbing');
        this._hoverAt(origin);
      }, WickChart._PRESS_MS);
    }

    _disarmPress() {
      if (this._pressTimer) clearTimeout(this._pressTimer);
      this._pressTimer = 0;
      this._pressOrigin = null;
    }

    /** Leave scrub mode and put the crosshair away. */
    _endScrub() {
      if (!this._scrub) return;
      this._scrub = false;
      if (this._hover) {
        this._hover = null;
        this._emitCrosshair(null);
        this._invalidate();
      }
    }

    _pointerDown(e) {
      if (e.button !== 0) return;
      this._stopPlayback(); // any touch interrupts the story
      this._canvas.setPointerCapture(e.pointerId);
      const pt = this._localPoint(e);
      this._pointers.set(e.pointerId, pt);
      if (this._layerClaim) return; // a layer owns a gesture: extra pointers are inert
      if (this._layers.length) {
        // layers get first claim on the pointer (hit-test their content);
        // a claim suppresses pinch/measure/brush/pan for this gesture
        const layer = this._layerHit(e, pt);
        if (layer) {
          this._pan = null;
          this._measuring = false;
          this._brushDrag = null;
          this._layerClaim = { layer, pointerId: e.pointerId };
          return;
        }
      }
      if (this._pointers.size === 2) {
        // a second finger is a pinch, never a press or a scrub
        this._disarmPress();
        this._endScrub();
        const [a, b] = [...this._pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this._pinch = {
          dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          spacing: this._view.spacing,
          idxAtMid: this._indexForX(mid.x),
          midX: mid.x,
        };
        this._pan = null;
        this._measuring = false;
        this._brushDrag = null;
      } else if (this._brush && !e.shiftKey && this._data.length) {
        // brush mode: plain drag selects a bar range (shift still measures)
        const idx = clamp(Math.round(this._indexForX(pt.x)), 0, this._data.length - 1);
        this._brushDrag = { i0: idx, i1: idx };
        this._brushSel = null;
        this._measuring = false;
        this._pan = null;
        this._invalidate();
      } else if (e.shiftKey && this._data.length) {
        // shift+drag → measure tool
        this._measuring = true;
        const idx = clamp(Math.round(this._indexForX(pt.x)), 0, this._data.length - 1);
        this._measure = {
          iA: idx,
          pA: this._yToPrice(pt.y),
          iB: idx,
          pB: this._yToPrice(pt.y),
          done: false,
        };
        this._pan = null;
        this._invalidate();
      } else {
        this._pan = { x: pt.x, rightIndex: this._view.rightIndex, moved: false };
        this._canvas.classList.add('grabbing');
        if (e.pointerType === 'touch') this._armPress(e.pointerId, pt);
      }
    }

    _pointerMove(e) {
      if (this._layerClaim) {
        if (this._layerClaim.pointerId === e.pointerId) {
          this._routeLayer(this._layerClaim.layer, e, this._localPoint(e), 'move');
        }
        return; // inert while a layer owns the gesture
      }
      const pt = this._localPoint(e);
      if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, pt);
      const ly = this._ly;

      // A finger that wanders before the press lands wanted to pan.
      const origin = this._pressOrigin;
      if (this._pressTimer && origin && origin.pointerId === e.pointerId) {
        if (Math.hypot(pt.x - origin.x, pt.y - origin.y) > WickChart._PRESS_SLOP) {
          this._disarmPress();
        }
      }

      // Scrub: the finger walks the crosshair, the viewport stays put.
      if (this._scrub && this._pointers.has(e.pointerId)) {
        this._hoverAt(pt);
        return;
      }

      if (this._pinch && this._pointers.size >= 2 && ly) {
        const [a, b] = [...this._pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const s = clamp(
          (this._pinch.spacing * dist) / this._pinch.dist,
          this._minSpacing(),
          WickChart._MAX_SP
        );
        this._view.spacing = s;
        this._view.rightIndex = this._pinch.idxAtMid + (ly.plotRight - mid.x) / s;
        this._auto = this._atRight();
        this._clampView();
        this._hover = null;
        this._invalidate();
        this._emitRange();
        return;
      }

      if (this._measuring && this._pointers.has(e.pointerId)) {
        const idx = clamp(Math.round(this._indexForX(pt.x)), 0, this._data.length - 1);
        this._measure.iB = idx;
        this._measure.pB = this._yToPrice(pt.y);
        this._invalidate();
        return;
      }

      if (this._brushDrag && this._pointers.has(e.pointerId) && this._data.length) {
        const idx = clamp(Math.round(this._indexForX(pt.x)), 0, this._data.length - 1);
        this._brushDrag.i1 = idx;
        this._invalidate();
        return;
      }

      if (this._pan && this._pointers.has(e.pointerId) && ly) {
        const dx = pt.x - this._pan.x;
        if (Math.abs(dx) > 3) this._pan.moved = true;
        this._view.rightIndex = this._pan.rightIndex - dx / this._view.spacing;
        this._auto = this._atRight();
        this._clampView();
        this._invalidate();
        this._emitRange();
        return;
      }

      if (!ly) return;
      // hover / crosshair
      this._hoverAt(pt);
    }

    _pointerUp(e) {
      const claim = this._layerClaim;
      if (claim && claim.pointerId === e.pointerId) {
        this._layerClaim = null;
        this._pointers.delete(e.pointerId);
        this._canvas.classList.remove('grabbing');
        this._routeLayer(claim.layer, e, this._localPoint(e), e.type === 'pointercancel' ? 'cancel' : 'up');
        return;
      }
      const had = this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._pinch = null;
      if (this._pressOrigin && this._pressOrigin.pointerId === e.pointerId) this._disarmPress();
      if (this._pointers.size === 0) {
        this._canvas.classList.remove('grabbing');
        // Lifting ends the scrub — the crosshair is not left stranded on a
        // touchscreen, where nothing else would ever clear it.
        this._endScrub();
        if (this._brushDrag && had) {
          const b = this._brushDrag;
          this._brushDrag = null;
          this._brushFinish(Math.min(b.i0, b.i1), Math.max(b.i0, b.i1));
        } else if (this._measuring) {
          this._measuring = false;
          if (this._measure) {
            this._measure.done = true;
            const m = this._measure;
            const d = this._data;
            const barA = d[clamp(m.iA, 0, d.length - 1)];
            const barB = d[clamp(m.iB, 0, d.length - 1)];
            this._fire('measure', {
              from: { index: m.iA, time: barA.time, price: m.pA },
              to: { index: m.iB, time: barB.time, price: m.pB },
              bars: Math.abs(m.iB - m.iA),
            });
          }
        } else if (this._pan && had && !this._pan.moved && this._data.length) {
          if (this._measure) {
            // a plain click clears a finished measurement
            this._measure = null;
            this._invalidate();
          } else {
            // tap / click select
            const pt = this._localPoint(e);
            const idx = clamp(Math.round(this._indexForX(pt.x)), 0, this._data.length - 1);
            const price = this._yToPrice(pt.y);
            this._fire('select', { index: idx, bar: this._data[idx], price });
          }
        }
        this._pan = null;
      }
    }

    _yToPrice(y) {
      const ly = this._ly;
      if (!ly || !this._data.length) return null;
      const scale = this._lastScale;
      if (!scale) return null;
      const { min, max, useLog } = scale;
      const t = max - ((y - ly.main.y0) / ly.main.h) * (max - min);
      return useLog ? Math.pow(10, t) : t;
    }

    _wheel(e) {
      const ly = this._ly;
      if (!ly || !this._data.length) return;
      this._stopPlayback();
      e.preventDefault();
      const pt = this._localPoint(e);
      const dx = e.deltaX;
      const dy = e.deltaY * (e.deltaMode === 1 ? 33 : 1);

      if (Math.abs(dx) > Math.abs(dy) && !e.ctrlKey) {
        // trackpad horizontal scroll → pan. Wheel deltas are viewport-relative:
        // deltaX>0 means "scroll right", i.e. reveal newer bars. On natural-scroll
        // trackpads this makes the content follow the fingers, matching drag.
        this._view.rightIndex += dx / this._view.spacing;
        this._auto = this._atRight();
        this._clampView();
        this._invalidate();
        this._emitRange();
        return;
      }

      const factor = Math.exp(-dy * (e.ctrlKey ? 0.008 : 0.0016));
      const oldSp = this._view.spacing;
      const newSp = clamp(oldSp * factor, this._minSpacing(), WickChart._MAX_SP);
      if (newSp === oldSp) return;
      const idxAtCursor = this._indexForX(pt.x);
      this._view.spacing = newSp;
      this._view.rightIndex = idxAtCursor + (ly.plotRight - pt.x) / newSp;
      this._auto = this._atRight();
      this._clampView();
      this._invalidate();
      this._emitRange();
    }

    _keydown(e) {
      const ly = this._ly;
      if (!ly || !this._data.length) return;
      this._stopPlayback();
      if (e.key === 'Escape' && this._layerClaim) {
        const claim = this._layerClaim;
        this._layerClaim = null;
        this._routeLayer(claim.layer, { pointerId: claim.pointerId }, null, 'cancel');
        this._invalidate();
        return;
      }
      if (e.key === 'Escape' && (this._brushSel || this._brushDrag)) {
        this.clearBrush();
        return;
      }
      const d = this._data;
      const key = e.key;
      const step = e.shiftKey ? 10 : 1;
      let handled = true;

      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const cur = this._hover ? this._hover.index : d.length - 1;
        const idx = clamp(cur + (key === 'ArrowRight' ? step : -step), 0, d.length - 1);
        this._hover = { index: idx, x: this._xFor(idx), y: this._hover ? this._hover.y : ly.main.y1 * 0.5 };
        this._maybeSonify(idx);
        this._emitCrosshair(this._hover);
        this._invalidate();
      } else if (key === 'Home') {
        this._view.rightIndex = Math.min(2 + ly.plotRight / this._view.spacing, d.length - 1);
        this._auto = this._atRight();
        this._invalidate();
        this._emitRange();
      } else if (key === 'End') {
        this._view.rightIndex = d.length - 1 + this._rightMargin();
        this._auto = true;
        this._invalidate();
        this._emitRange();
      } else if (key === '+' || key === '=') {
        this._view.spacing = clamp(this._view.spacing * 1.25, this._minSpacing(), WickChart._MAX_SP);
        this._clampView();
        this._invalidate();
        this._emitRange();
      } else if (key === '-' || key === '_') {
        this._view.spacing = clamp(this._view.spacing / 1.25, this._minSpacing(), WickChart._MAX_SP);
        this._clampView();
        this._invalidate();
        this._emitRange();
      } else if (key === 'Escape') {
        this._hover = null;
        this._measure = null;
        this._measuring = false;
        this._emitCrosshair(null);
        this._invalidate();
      } else if (key === 'Enter' || key === ' ') {
        this.fit();
      } else {
        handled = false;
      }
      if (handled) e.preventDefault();
    }

    /* ------------------------------------------------------------ *
     * Sonification — the chart by ear (a11y)
     * ------------------------------------------------------------ */

    /** Lazily-created shared AudioContext (enable within a user gesture). */
    _audio() {
      if (this._actx) return this._actx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        this._actx = new AC();
      } catch (_) {
        this._actx = null;
      }
      return this._actx;
    }

    /** Short sine blip; `when` schedules against AudioContext time. */
    _tone(freq, dur = 0.14, when = 0) {
      const ctx = this._audio();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const t0 = when || ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    }

    /** One tone for a bar's close, pitched by its position on the y-scale. */
    _sonifyBar(i) {
      if (!this._sonify || !this._data.length || !this._lastScale) return;
      const d = this._renderBars();
      const b = d[clamp(i, 0, d.length - 1)];
      if (!b) return;
      this._tone(priceToFreq(b.close, this._lastScale));
    }

    /** One tone per crosshair bar change (dedupes y-only moves). */
    _maybeSonify(idx) {
      if (!this._sonify) return;
      if (this._lastToneIdx === idx) return;
      this._lastToneIdx = idx;
      this._sonifyBar(idx);
    }

    /**
     * Play the visible range as a pitch sweep (~4s), riding the crosshair —
     * the audible equivalent of running your eye along the price line.
     */
    playRange() {
      if (!this._data.length || !this._ly) return;
      const ctx = this._audio();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const d = this._renderBars();
      const count = Math.max(2, Math.round(this._ly.plotRight / this._view.spacing));
      const i0 = clamp(Math.floor(this._view.rightIndex - count) - 1, 0, d.length - 1);
      const i1 = clamp(Math.ceil(this._view.rightIndex), 0, d.length - 1);
      if (i1 - i0 < 2) return;
      const N = Math.min(120, i1 - i0 + 1);
      const stepMs = Math.min(70, Math.max(24, 4000 / N));
      const t0 = ctx.currentTime + 0.05;
      for (let k = 0; k < N; k++) {
        const i = Math.round(i0 + ((i1 - i0) * k) / (N - 1));
        const b = d[i];
        if (!b) continue;
        this._tone(priceToFreq(b.close, this._lastScale), stepMs / 1000 * 0.9, t0 + (k * stepMs) / 1000);
      }
      // ride the crosshair along the sweep for sighted users
      this._playToken++;
      const token = this._playToken;
      let k = 0;
      const timer = setInterval(() => {
        if (token !== this._playToken || !this._connected) {
          clearInterval(timer);
          return;
        }
        if (k >= N) {
          clearInterval(timer);
          this._hover = null;
          this._emitCrosshair(null);
          this._invalidate();
          return;
        }
        const i = Math.round(i0 + ((i1 - i0) * k) / (N - 1));
        this._hover = { index: i, x: this._xFor(i), y: this._ly ? this._ly.main.h * 0.5 : 0 };
        this._invalidate();
        k++;
      }, stepMs);
    }

    _emitCrosshair(hover) {
      let detail = null;
      if (hover && this._data[hover.index]) {
        detail = {
          index: hover.index,
          bar: this._data[hover.index],
          x: hover.x,
          y: hover.y,
          price: this._yToPrice(hover.y),
        };
      }
      this._fire('crosshair', detail);

      // co-view: share the pointer with peer charts (leave events bypass throttle)
      if (this._coviewCh) {
        if (!detail) {
          this._coviewSend({ type: 'cross', time: null, yFrac: null });
        } else {
          const now = performance.now();
          if (now - this._coviewLast > 40) {
            this._coviewLast = now;
            const ly = this._ly;
            this._coviewSend({
              type: 'cross',
              time: detail.bar.time,
              yFrac: ly && isNum(detail.y) ? clamp(detail.y / ly.main.h, 0, 1) : null,
            });
          }
        }
      }
    }

    /* ------------------------------------------------------------ *
     * Cross-tab co-view (BroadcastChannel)
     * ------------------------------------------------------------ */

    /** Join/leave the co-view channel named by the `co-view` attribute. */
    _setupCoView() {
      if (this._coviewCh) {
        try {
          this._coviewCh.close();
        } catch (_) {}
        this._coviewCh = null;
      }
      clearInterval(this._coviewBeat);
      this._coviewBeat = 0;
      clearTimeout(this._ghostTimer);
      if (this._ghost) {
        this._ghost = null;
        this._invalidate();
      }
      if (this._presence && this._presence.peers.size) {
        const left = this._presence.list();
        this._presence = new PresenceTracker();
        this._fire('peers', { peers: [], joined: [], left });
      }
      const name = this._coviewName;
      if (!name || !this._connected || typeof BroadcastChannel === 'undefined') return;
      if (!this._coviewPeer) this._coviewPeer = 'p' + Math.random().toString(36).slice(2, 8);
      try {
        const ch = new BroadcastChannel('wick-co-view:' + name);
        ch.onmessage = (ev) => this._onCoMessage(ev.data);
        this._coviewCh = ch;
      } catch (_) {}
      // presence: announce immediately, then heartbeat so idle peers stay
      // warm (and stale ones sweep) without waiting for a pan/zoom
      this._coviewSendView(true);
      this._coviewBeat = setInterval(() => {
        this._coviewSendView(true);
        const left = this._presence.sweep();
        if (left.length) {
          this._fire('peers', { peers: this._presence.list(), joined: [], left });
          this._invalidate();
        }
      }, 4000);
    }

    /** Broadcast our visible range for presence; throttled unless forced. */
    _coviewSendView(force) {
      if (!this._coviewCh) return;
      const r = this.getVisibleRange();
      if (!r) return;
      const now = performance.now();
      if (!force && now - this._coviewViewLast < 120) return;
      this._coviewViewLast = now;
      this._coviewSend({
        type: 'view',
        from: r.from,
        to: r.to,
        name: this._coviewLabel || null,
      });
    }

    _coviewSend(msg) {
      if (!this._coviewCh) return;
      try {
        this._coviewCh.postMessage({ v: 1, peer: this._coviewPeer, ...msg });
      } catch (_) {}
    }

    _onCoMessage(m) {
      if (!m || m.v !== 1 || m.peer === this._coviewPeer) return;
      if (m.type === 'view') {
        const joined = this._presence.track(m.peer, {
          range: { from: m.from, to: m.to },
          name: m.name,
        });
        this._invalidate();
        if (joined) {
          const p = this._presence.peers.get(m.peer);
          this._fire('peers', {
            peers: this._presence.list(),
            joined: [p ? { ...p, range: p.range && { ...p.range } } : { id: m.peer }],
            left: [],
          });
        }
        return;
      }
      if (m.type === 'bye') {
        const left = this._presence.drop(m.peer);
        if (left) this._fire('peers', { peers: this._presence.list(), joined: [], left: [left] });
        this._invalidate();
        return;
      }
      if (m.type !== 'cross') return;
      if (m.time == null) {
        if (this._ghost) {
          this._ghost = null;
          clearTimeout(this._ghostTimer);
          this._invalidate();
        }
        return;
      }
      if (!isNum(m.time) || !this._data.length) return;
      this._ghost = {
        index: WickChart._indexForTime(this._data, m.time),
        yFrac: isNum(m.yFrac) ? clamp(m.yFrac, 0, 1) : null,
        at: Date.now(),
      };
      clearTimeout(this._ghostTimer);
      this._ghostTimer = setTimeout(() => {
        this._ghost = null;
        this._invalidate();
      }, 2500);
      this._invalidate();
    }

    /** Dispatch `wick:name` (canonical) plus the deprecated `hab:name` alias,
     *  so 0.x listeners keep working until 2.0. */
    _fire(name, detail) {
      this.dispatchEvent(new CustomEvent('wick:' + name, { detail }));
      this.dispatchEvent(new CustomEvent('hab:' + name, { detail }));
    }

    /**
     * Live co-view peers: who else is in the room and the time window each
     * one is looking at — [{ id, name, range: {from, to}, at }], oldest
     * sighting first. Peers fade out ~12 s after their last sighting.
     * @returns {object[]}
     */
    getPeers() {
      return this._presence ? this._presence.list() : [];
    }

    /**
     * Narrated timeline for a window (default: the visible range) — pivot
     * highs/lows, volume spikes, gaps, RSI divergences plus derived legs
     * ("+12.4% over 38 bars"), sorted by index. Pure data, perfect for
     * caption UIs or the walk player.
     *   chart.narrate();                        // visible range
     *   chart.narrate({ from, to });            // times in ms (s accepted)
     * @param {{from?: number, to?: number}} [range]
     * @returns {{i: number, time: number, type: string, side: string, note: string,
     *            legPct?: number, legBars?: number}[]}
     */
    narrate(range) {
      const d = this._data;
      if (!d.length) return [];
      let i0 = 0;
      let i1 = d.length - 1;
      if (range && isNum(range.from) && isNum(range.to)) {
        i0 = WickChart._indexForTime(d, WickChart._timeToMs(range.from));
        i1 = WickChart._indexForTime(d, WickChart._timeToMs(range.to));
        if (i0 > i1) [i0, i1] = [i1, i0];
      }
      return narrateWindow(d, i0, i1);
    }

    /**
     * Walk the chart through history like a story: the viewport slides
     * from `from` to `to` while `wick:walk` events announce every step and
     * the narrator's events (spikes, gaps, pivots, legs) as they're crossed.
     * Any user interaction — pointer, wheel, keys, double-click — stops it.
     *   chart.walk({ from: 0, to: 500, speed: 120, step: 10 });
     *   chart.addEventListener('wick:walk', (e) => showCaption(e.detail));
     *   // detail: { phase: 'step'|'end'|'stop', index, events: [...], from, to }
     * @param {{from?: number, to?: number, speed?: number, step?: number}} [opts]
     *        from/to are bar indices (default: last ~500 bars → the end)
     * @returns {boolean} true when the walk started
     */
    walk(opts = {}) {
      this.stopWalk(true);
      const d = this._data;
      if (!d.length || !this._connected) return false;
      const to = clamp(Math.round(+opts.to || d.length - 1), 0, d.length - 1);
      const from = clamp(Math.round(opts.from != null ? +opts.from : Math.max(0, to - 500)), 0, to);
      const span = to - from + 1;
      // window width: the current viewport, but never more than ~⅓ of the
      // span (a fully zoomed-out chart would otherwise start at `to`)
      const widthBars = clamp(
        Math.min(
          this._ly ? Math.round(this._ly.plotRight / this._view.spacing) : 120,
          Math.max(10, Math.ceil(span / 3))
        ),
        10,
        span
      );
      const events = narrateWindow(d, from, to, { pivot: 8 });
      const speed = clamp(Math.round(+opts.speed || 120), 16, 2000);
      const step = clamp(Math.round(+opts.step || Math.max(1, Math.round(widthBars / 12))), 1, 500);
      let cursor = Math.min(from + widthBars - 1, to);
      let ev = 0;
      let ended = false;
      const tick = () => {
        if (ended) return;
        this._auto = false;
        this._view.rightIndex = cursor;
        this._clampView();
        this._invalidate();
        this._emitRange();
        const hits = [];
        while (ev < events.length && events[ev].i <= cursor) hits.push(events[ev++]);
        this._fire('walk', { phase: 'step', index: cursor, events: hits, from, to });
        if (cursor >= to) {
          ended = true;
          clearInterval(this._walkTimer);
          this._walkTimer = 0;
          this._fire('walk', { phase: 'end', index: cursor, events: [], from, to });
        } else {
          cursor = Math.min(cursor + step, to);
        }
      };
      this._walkTimer = setInterval(tick, speed);
      tick(); // first step lands immediately
      return true;
    }

    /**
     * Stop the running walk (if any). Fires a final `wick:walk`
     * { phase: 'stop' } unless called internally.
     */
    stopWalk(silent) {
      if (!this._walkTimer) return;
      clearInterval(this._walkTimer);
      this._walkTimer = 0;
      if (!silent) this._fire('walk', { phase: 'stop' });
    }

    /**
     * Commit a brush selection over [i0, i1]: stores it (draws the band
     * and delta chip) and fires `wick:brush` with the range statistics.
     * @param {number} i0 first index
     * @param {number} i1 last index
     */
    _brushFinish(i0, i1) {
      if (!this._data.length) return;
      const stats = brushStats(this._data, i0, i1);
      if (!stats) {
        this._brushSel = null;
        this._invalidate();
        return;
      }
      this._brushSel = { i0, i1, stats };
      this._invalidate();
      this._fire('brush', stats);
    }

    /** Clear the committed brush selection (if any). Escape does the same. */
    clearBrush() {
      if (this._brushSel || this._brushDrag) {
        this._brushSel = null;
        this._brushDrag = null;
        this._invalidate();
      }
    }

    /** @returns {object|null} the committed selection { i0, i1, stats } */
    get brushSelection() {
      if (!this._brushSel) return null;
      const { i0, i1, stats } = this._brushSel;
      return { i0, i1, stats: { ...stats, from: { ...stats.from }, to: { ...stats.to } } };
    }

    /**
     * Capture the current chart state as a story scene: view, series type,
     * indicators, overlays, scenario and risk plan, plus a title/note.
     * Build guided tours by capturing several and playing them back.
     *   const story = [
     *     chart.captureScene('Overview', 'The full picture'),
     *     { title: 'The breakout', range: { from, to }, indicators: 'sma:20' },
     *   ];
     *   chart.playStory(story);
     * @param {string} [title]
     * @param {string} [note]
     * @returns {object} scene (plain data — snapshot of the moment)
     */
    captureScene(title, note) {
      const scene = {
        title: title != null ? String(title).slice(0, 60) : '',
        note: note != null ? String(note).slice(0, 200) : '',
        range: this.getVisibleRange() || undefined,
        type: this.getAttribute('type') || 'candles',
        indicators: this.getAttribute('indicators') || null,
      };
      const ovs = this.overlays;
      if (ovs.length) scene.overlays = ovs;
      const sc = this.scenario;
      if (sc) scene.scenario = sc;
      const rp = this.riskPlan;
      if (rp) scene.riskPlan = rp;
      return scene;
    }

    /** @returns {object[]|null} a copy of the last played story */
    getStory() {
      return this._story ? this._story.map((s) => ({ ...s })) : null;
    }

    /**
     * Play a story: each scene applies its state (type / indicators /
     * overlays / scenario / risk plan — set or clear), the camera eases
     * to its range, then holds for its dwell. `wick:story` events narrate:
     *   { phase: 'scene' | 'end' | 'stop', index, total, scene, title, note }
     * Any user interaction — pointer, wheel, keys, double-click — stops it.
     * @param {object[]} story scenes (invalid entries dropped, max 20)
     * @param {{dwell?: number, panMs?: number, loop?: boolean}} [opts]
     *        panMs clamps 100–5000 (default 900); loop replays forever
     * @returns {boolean} true when playback started
     */
    playStory(story, opts = {}) {
      this.stopStory(true);
      const scenes = sceneList(story);
      if (!scenes.length || !this._data.length || !this._connected) return false;
      const token = ++this._storyToken;
      this._story = scenes;
      const panMs = clamp(Math.round(+opts.panMs || 900), 100, 5000);
      const loop = opts.loop === true;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const run = async () => {
        let idx = 0;
        while (token === this._storyToken) {
          const sc = scenes[idx];
          this._fire('story', {
            phase: 'scene', index: idx, total: scenes.length,
            scene: sc, title: sc.title, note: sc.note,
          });
          this._applyScene(sc);
          const target = this._sceneTarget(sc);
          if (target) await this._storyTween(target, panMs, token);
          if (token !== this._storyToken) return;
          await wait(sc.dwell);
          if (token !== this._storyToken) return;
          idx++;
          if (idx >= scenes.length) {
            if (loop) idx = 0;
            else {
              this._fire('story', { phase: 'end', index: idx - 1, total: scenes.length });
              return;
            }
          }
        }
      };
      run();
      return true;
    }

    /**
     * Stop story playback (if running). Fires a final `wick:story`
     * { phase: 'stop' } unless called internally.
     */
    stopStory(silent) {
      if (!this._storyToken) return;
      this._storyToken = 0;
      if (!silent) this._fire('story', { phase: 'stop' });
    }

    /** Apply a scene's state (only the fields it carries). */
    _applyScene(sc) {
      if (sc.type) this.setAttribute('type', sc.type);
      if (sc.indicators != null) this.setAttribute('indicators', sc.indicators);
      if (sc.overlays) this.setOverlays(sc.overlays);
      if (sc.scenario === 'clear') this.clearScenario();
      else if (sc.scenario) this.setScenario(sc.scenario);
      if (sc.riskPlan === 'clear') this.clearRiskPlan();
      else if (sc.riskPlan) this.setRiskPlan(sc.riskPlan);
    }

    /** Map a scene's time range to bar indices (null when not applicable). */
    _sceneTarget(sc) {
      if (!sc.range || !this._data.length) return null;
      let i0 = WickChart._indexForTime(this._data, WickChart._timeToMs(sc.range.from));
      let i1 = WickChart._indexForTime(this._data, WickChart._timeToMs(sc.range.to));
      if (i0 > i1) [i0, i1] = [i1, i0];
      return i1 - i0 >= 2 ? { i0, i1 } : null;
    }

    /** Ease the viewport to { i0, i1 } over `ms`; resolves early if the
     *  token changes (superseded or stopped). rAF when available. */
    _storyTween(target, ms, token) {
      const ly = this._ly;
      const d = this._data;
      if (!ly || !d.length) return Promise.resolve();
      const sp1 = clamp(ly.plotRight / (target.i1 - target.i0), this._minSpacing(), WickChart._MAX_SP);
      const from = { right: this._view.rightIndex, sp: this._view.spacing };
      const to = { right: target.i1, sp: sp1 };
      const t0 = performance.now();
      this._auto = false;
      return new Promise((resolve) => {
        const step = () => {
          if (token !== this._storyToken) return resolve();
          const e = easeInOutCubic(Math.min(1, (performance.now() - t0) / ms));
          this._view.rightIndex = from.right + (to.right - from.right) * e;
          this._view.spacing = from.sp + (to.sp - from.sp) * e;
          this._clampView();
          this._invalidate();
          this._emitRange();
          if (e >= 1) resolve();
          else if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
          else setTimeout(step, 16);
        };
        step();
      });
    }

    /** Interrupt narrated playback (walk / story) on user input. */
    _stopPlayback() {
      if (this._walkTimer) this.stopWalk();
      if (this._storyToken) this.stopStory();
    }

    _emitRange() {
      const r = this.getVisibleRange();
      if (!r) return;
      this._fire('range', r);
      if (this._coviewCh) this._coviewSendView();
    }
  }

// 0.x alias events (`hab:*`) keep firing alongside the canonical `wick:*`
// until 2.0 — but only listeners on the deprecated channel warn (once),
// so canonical usage stays silent.
if (WickChart.prototype.addEventListener) {
  const origAddEventListener = WickChart.prototype.addEventListener;
  WickChart.prototype.addEventListener = function (type) {
    if (typeof type === 'string' && type.startsWith('hab:')) {
      warnDeprecatedAlias('hab:* events are removed in 2.0 — listen for wick:*');
    }
    return origAddEventListener.apply(this, arguments);
  };
}

if (typeof customElements !== 'undefined') {
  if (!customElements.get('wick-chart')) {
    customElements.define('wick-chart', WickChart);
  }
  // 0.x alias: same element under its old tag name (deprecated, removed in 2.0)
  if (!customElements.get('hab-chart')) {
    /** @deprecated use <wick-chart> */
    class HabChart extends WickChart {
      constructor() {
        super();
        warnDeprecatedAlias('<hab-chart> is removed in 2.0 — use <wick-chart>');
      }
    }
    customElements.define('hab-chart', HabChart);
  }
}

export default WickChart;
export { WickChart };
