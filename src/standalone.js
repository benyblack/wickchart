/* ==========================================================================
 * <wick-chart> standalone export — send a chart, not a screenshot.
 *
 *   import { exportChart, downloadChart, adoptShared, attachDrop }
 *     from 'wickchart/standalone';
 *
 *   const html = await exportChart(chart);        // one self-contained .html
 *   await downloadChart(chart, 'btc-1h.html');    // …as a file download
 *   await adoptShared(chart, file);               // open a shared file into a chart
 *   attachDrop(chart);                            // drag a shared file anywhere → restore
 *
 * The produced file inlines the whole library module (core.js + the
 * <wick-chart> element, imports resolved into one module script), the chart
 * state (getState()) and the data as compact bar arrays — it opens offline,
 * from a file manager or an email attachment, with zero requests. Only a
 * zero-dependency, no-build module can do this: there is nothing else to
 * inline. The `pluginSources` / `init` options let a host append extra
 * already-loaded module sources (a plugin package) and a bootstrap line, so
 * narrated stories and scenarios export through the same machinery.
 *
 * How the inlining works without a build step: the emitted page carries ONE
 * <script type="module"> holding core.js followed by wick-chart.js with the
 * module statements that tie files together (imports, export lists)
 * flattened away — module scope does the rest. `export function`
 * declarations stay (valid module syntax), the names the element imported
 * from core resolve in the shared scope, and the evaluation order (core
 * first) is exactly what the two files had as a graph. tests/standalone
 * pins the real sources to this contract with `node --check`.
 *
 * Browser needs on the export side: fetch of the original module files
 * (same-origin script-tag/ESM usage, or a CORS-friendly CDN). Hosts that
 * bundle the library can pass `coreSource`/`chartSource` strings instead.
 * ========================================================================== */

import { getTheme, THEMES } from './core.js';

/* ------------------------------ constants ------------------------------ */

/** Payload script marker — the round-trip seam between export and open. */
const PAYLOAD_ID = 'wickchart-payload';

/* --------------------------- pure: transforms --------------------------- */

/**
 * Make a module's source safe to concatenate into one shared module scope:
 * `import` statements are removed (named/default/namespace/side-effect —
 * the names resolve against the other flattened sources), local export
 * lists and re-export-from lists are dropped (the declarations stay in
 * scope; duplicated export *names* across files would be a syntax error),
 * and `export default` keeps its declaration while bare binding re-exports
 * go. Sources must not rely on anonymous default expressions.
 * @param {string} src
 * @returns {string}
 */
export function flattenModule(src) {
  return String(src)
    .replace(/^[ \t]*import\s*(?:\{[\s\S]*?\}|[\w$]+|\*(?:\s+as\s+[\w$]+)?)(?:\s*,\s*(?:\{[\s\S]*?\}|[\w$]+|\*\s*as\s+[\w$]+))?\s*from\s*['"][^'"]*['"];?[ \t]*$/gm, '')
    .replace(/^[ \t]*import\s*['"][^'"]*['"];?[ \t]*$/gm, '')
    .replace(/^[ \t]*export\s*\{[^}]*\}(?:\s*from\s*['"][^'"]*['"])?;?[ \t]*$/gm, '')
    .replace(/^([ \t]*)export\s+default\s+(class|function)\b/gm, '$1$2')
    .replace(/^[ \t]*export\s+default\s+[^;\n]*;?[ \t]*$/gm, '');
}

/** Make embedded JS safe inside a <script> tag: a literal `</script` would
 *  close the element early and `<!--` can trip the tokenizer's escaped
 *  states (an escaping backslash is identity inside strings and regexes,
 *  and comments don't care). @param {string} src @returns {string} */
export const escapeScript = (src) =>
  String(src)
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--');

/** Serialize JSON for embedding in HTML: no raw `<` (blocks `</script>`
 *  breakout), U+2028/29 escaped for good measure. @param {unknown} v */
export const embedJson = (v) =>
  JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** Escape a string for HTML text/attribute contexts. @param {string} s */
export const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Bars → compact row arrays (`[time, open, high, low, close, volume|null]`),
 * newest `maxBars` kept, non-finite rows dropped. Roughly halves the JSON
 * payload vs objects.
 * @param {Array<import('./core.js').Bar>} bars
 * @param {number} [maxBars]
 * @returns {number[][]}
 */
export function compactBars(bars, maxBars) {
  if (!Array.isArray(bars)) return [];
  const rows = [];
  for (const b of bars) {
    if (!b || !Number.isFinite(b.time) || !Number.isFinite(b.open) || !Number.isFinite(b.high) ||
        !Number.isFinite(b.low) || !Number.isFinite(b.close)) continue;
    rows.push([b.time, b.open, b.high, b.low, b.close,
      b.volume != null && Number.isFinite(+b.volume) ? +b.volume : null]);
  }
  const n = Number(maxBars);
  return Number.isFinite(n) && n >= 0 && n < rows.length ? rows.slice(rows.length - Math.floor(n)) : rows;
}

/**
 * Row arrays → bar objects (the inverse of compactBars — what the bootstrap
 * inside an exported file and adoptShared() both run).
 * @param {unknown} rows
 * @returns {Array<import('./core.js').Bar>}
 */
export function expandBars(rows) {
  if (!Array.isArray(rows)) throw new Error('wickchart: shared payload has no bars array');
  return rows.map((r) => {
    if (!Array.isArray(r) || r.length < 5 || r.slice(0, 5).some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error('wickchart: shared payload has a malformed bar row');
    }
    return { time: r[0], open: r[1], high: r[2], low: r[3], close: r[4],
      volume: typeof r[5] === 'number' && Number.isFinite(r[5]) ? r[5] : undefined };
  });
}

/* ----------------------------- pure: payload ----------------------------- */

/**
 * The shared payload: format version, label/credit, the state snapshot
 * (with its label baked in) and compact bars.
 * @param {object} chart a <wick-chart> (public API only: data, getState,
 *   getAttribute)
 * @param {{title?: string, source?: string, maxBars?: number,
 *   state?: import('./core.js').ChartState}} [opts]
 */
export function payloadFor(chart, opts = {}) {
  const data = chart && chart.data;
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error('exportChart(chart): the chart needs data (2+ bars)');
  }
  const label = (typeof opts.title === 'string' && opts.title) ||
    (typeof chart.getAttribute === 'function' ? chart.getAttribute('label') : '') || '';
  const state = { ...(opts.state || (typeof chart.getState === 'function' ? chart.getState() : {})) };
  if (label && typeof state.label !== 'string') state.label = label;
  const payload = {
    wickchart: 1,
    exportedAt: Date.now(),
    label,
    source: typeof opts.source === 'string' ? opts.source : '',
    state,
    bars: compactBars(data, opts.maxBars),
  };
  // a registered custom theme travels with the chart so the standalone
  // renders identically (built-in dark/light are already in the inlined core)
  const name = state.theme;
  if (typeof name === 'string' && name !== 'dark' && name !== 'light') {
    const pal = getTheme(name);
    if (pal) payload.theme = { name, palette: pal };
  }
  return payload;
}

/* ----------------------------- pure: builder ----------------------------- */

/** The bootstrap appended inside the inlined module script — module scope,
 *  so core exports (registerTheme) and the element are directly reachable. */
const BOOTSTRAP = `
;(function () {
  var p = JSON.parse(document.getElementById(${JSON.stringify(PAYLOAD_ID)}).textContent);
  if (p.theme) registerTheme(p.theme.name, p.theme.palette);
  var chart = document.querySelector('wick-chart');
  chart.setData(p.bars.map(function (b) {
    return { time: b[0], open: b[1], high: b[2], low: b[3], close: b[4],
      volume: b[5] == null ? undefined : b[5] };
  }));
  chart.setState(p.state);
})();`;

/**
 * Assemble the self-contained page: host markup, the JSON payload and the
 * one-module-script library (core + element + optional plugin sources,
 * imports stripped, `</script` escaped) followed by the bootstrap.
 * @param {{payload: object, coreSource: string, chartSource: string,
 *   pluginSources?: string, init?: string}} parts
 * @returns {string} html
 */
export function buildStandalone(parts) {
  const p = parts && parts.payload;
  if (!p || typeof p !== 'object') throw new Error('buildStandalone: a payload is required');
  const label = typeof p.label === 'string' ? p.label : '';
  const title = (label || 'WickChart') + ' · WickChart';
  const theme = (p.theme && p.theme.palette) || getTheme(p.state && p.state.theme) || THEMES.dark;
  const code = [
    parts.coreSource,
    flattenModule(parts.chartSource || ''),
    parts.pluginSources ? flattenModule(parts.pluginSources) : '',
    BOOTSTRAP,
    parts.init || '',
  ].filter(Boolean).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="wickchart">
<title>${escapeHtml(title)}</title>
<style>html,body{margin:0;height:100%;background:${theme.bg}}wick-chart{display:block;width:100%;height:100%}</style>
</head>
<body>
<wick-chart></wick-chart>
<noscript>This chart was exported as a self-contained file and needs JavaScript.</noscript>
<script type="application/json" id="${PAYLOAD_ID}">${embedJson(p)}</script>
<script type="module">
${escapeScript(code)}
</script>
</body>
</html>
`;
}

/* --------------------------- browser: export --------------------------- */

/** Resolve the module text, honouring explicit overrides (tests; hosts that
 *  bundle the library and keep the sources as strings). */
async function moduleSources(opts) {
  if (opts.coreSource && opts.chartSource) {
    return { coreSource: opts.coreSource, chartSource: opts.chartSource };
  }
  if (typeof fetch !== 'function') {
    throw new Error('exportChart requires a browser (fetch of the module files)');
  }
  const read = async (url, what) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`exportChart: could not read the ${what} module (${res.status} ${url})`);
    return res.text();
  };
  let sources;
  try {
    sources = await Promise.all([
      read(new URL('./core.js', import.meta.url), 'core'),
      read(new URL('./wick-chart.js', import.meta.url), 'element'),
    ]);
  } catch (err) {
    // a bundled host has no ./core.js next to import.meta.url — say what to do
    throw new Error(
      `exportChart: could not read the module files (${err && err.message || err}). ` +
      'Standalone export needs the original core.js / wick-chart.js reachable ' +
      '(script-tag, ESM or CDN usage) — or pass coreSource/chartSource strings.');
  }
  return { coreSource: sources[0], chartSource: sources[1] };
}

/**
 * Export a chart as one self-contained HTML file — the module inlined, the
 * state and the data embedded. It opens offline; dragging it onto a page
 * with a chart restores the state (adoptShared).
 * @param {object} chart a <wick-chart>
 * @param {{title?: string, label?: string, source?: string, maxBars?: number,
 *   state?: import('./core.js').ChartState, as?: 'html'|'blob',
 *   coreSource?: string, chartSource?: string, pluginSources?: string,
 *   init?: string}} [opts]
 * @returns {Promise<string|Blob>}
 */
export async function exportChart(chart, opts = {}) {
  const payload = payloadFor(chart, opts);
  const sources = await moduleSources(opts);
  const html = buildStandalone({ ...sources, payload, pluginSources: opts.pluginSources, init: opts.init });
  if (opts.as === 'blob') {
    return new Blob([html], { type: 'text/html' });
  }
  return html;
}

/**
 * Export and trigger a download (browser only).
 * @returns {Promise<void>}
 */
export async function downloadChart(chart, filename = 'wickchart.html', opts = {}) {
  if (typeof document === 'undefined') throw new Error('downloadChart requires a browser');
  const blob = await exportChart(chart, { ...opts, as: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------------------------- browser: open ---------------------------- */

/**
 * Read the payload back out of a shared file (or its HTML text) — the
 * inverse of exportChart, minus the markup.
 * @param {File|Blob|string} input a shared .html File/Blob, or its text
 * @returns {Promise<{wickchart: number, exportedAt: number, label: string,
 *   source: string, state: import('./core.js').ChartState,
 *   bars: Array<import('./core.js').Bar>, theme?: {name: string, palette: object}}>}
 */
export async function openShared(input) {
  const text = typeof input === 'string' ? input
    : input && typeof input.text === 'function' ? await input.text()
    : (() => { throw new Error('openShared: expected a File, Blob or HTML string'); })();
  let json = null;
  if (typeof DOMParser !== 'undefined') {
    const el = new DOMParser().parseFromString(text, 'text/html').getElementById(PAYLOAD_ID);
    if (el) json = el.textContent;
  }
  if (json == null) {
    const m = text.match(new RegExp(`<script[^>]*id="${PAYLOAD_ID}"[^>]*>([\\s\\S]*?)<\\/script>`));
    if (m) json = m[1];
  }
  if (json == null) throw new Error('openShared: not a WickChart shared file (no payload found)');
  const payload = JSON.parse(json);
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.bars) || !payload.state) {
    throw new Error('openShared: malformed shared payload');
  }
  payload.bars = expandBars(payload.bars);
  return payload;
}

/**
 * Open a shared file into a live chart — data, then state (the view range
 * rides along in the state).
 * @returns {Promise<object>} the payload (see openShared)
 */
export async function adoptShared(chart, input) {
  const payload = await openShared(input);
  if (typeof payload.state.label === 'string' && payload.state.label) {
    chart.setAttribute('label', payload.state.label);
  }
  chart.setData(payload.bars);
  chart.setState(payload.state);
  return payload;
}

/**
 * Wire drag-and-drop: dragging a shared file onto the page (or any element)
 * restores it into the chart. Returns a detach() handle.
 * @param {object} chart a <wick-chart>
 * @param {{target?: EventTarget, onadopt?: (p: object) => void,
 *   onerror?: (e: unknown) => void}} [opts]
 * @returns {() => void} detach
 */
export function attachDrop(chart, opts = {}) {
  const target = opts.target || (typeof document !== 'undefined' ? document : null);
  if (!target || typeof target.addEventListener !== 'function') {
    throw new Error('attachDrop: no drop target (pass { target } outside a document)');
  }
  const onDragOver = (e) => e.preventDefault();
  const onDrop = async (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    try {
      const payload = await adoptShared(chart, file);
      if (typeof opts.onadopt === 'function') opts.onadopt(payload);
    } catch (err) {
      (typeof opts.onerror === 'function' ? opts.onerror : console.error)(
        'wickchart: dropped file was not a shared chart —', err && err.message || err);
    }
  };
  target.addEventListener('dragover', onDragOver);
  target.addEventListener('drop', onDrop);
  return () => {
    target.removeEventListener('dragover', onDragOver);
    target.removeEventListener('drop', onDrop);
  };
}
