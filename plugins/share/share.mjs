/**
 * wickchart-share — the chart as a file: `exportChart()` produces ONE
 * self-contained .html (the library's own module sources inlined, the
 * chart's state and bars embedded as a payload) that opens offline in any
 * browser and paints the exact chart again. Only a zero-dependency,
 * no-build library can do this — there is nothing else to ship.
 *
 *   import { attachShare } from 'wickchart-share';
 *   const share = attachShare(chart);
 *   await share.downloadChart('btc.html');   // triggers the browser download
 *   const html = await share.exportChart();  // …or take the string
 *
 * The exported file needs no network: the core and chart modules are
 * embedded as base64 data-URL modules (the chart module's `from './core.js'`
 * line is rewritten to the core's data URL at export time), and a small
 * bootstrap applies the payload after import. `parseChartFile()` reads a
 * shared file back into `{ bars, state, meta }` for host-side import.
 *
 * Source discovery: the library's modules are located via resource-timing
 * entries (any way the page loaded them — script tag, import map, dynamic
 * import), or passed explicitly as `attachShare(chart, { coreUrl, chartUrl })`.
 * Bundled hosts have no module URLs to find — pass the sources directly via
 * `exportChart({ sources })` or keep the library unbundled (it wants no
 * build step anyway).
 */

const IMPORT_LINE = "from './core.js'";
const PAYLOAD_ID = 'wc-share-payload';

/** JSON-stringify with `<` escaped, so an embedded string can never
 * terminate its surrounding <script> block. */
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003C');

/** Extract the payload back out of a shared file (raw text in, data out). */
export function parseChartFile(text) {
  const m = /<script id="wc-share-payload"[^>]*>([\s\S]*?)<\/script>/.exec(text);
  if (!m) throw new Error('parseChartFile: not a wickchart shared file (no payload block)');
  const payload = JSON.parse(m[1]);
  if (payload.v !== 1) throw new Error(`parseChartFile: unsupported payload version ${payload.v}`);
  const { bars, state, meta } = payload;
  if (!Array.isArray(bars)) throw new Error('parseChartFile: payload has no bars');
  return { bars, state, meta };
}

/**
 * Build the standalone page. Pure — everything testable in Node.
 * @param {{coreSrc: string, chartSrc: string, bars: object[], state?: object,
 *          meta?: {title?: string, label?: string, exported?: string}}} p
 * @returns {string}
 */
export function buildStandaloneHTML({ coreSrc, chartSrc, bars, state = null, meta = {} }) {
  if (!coreSrc || !chartSrc) throw new Error('buildStandaloneHTML: coreSrc and chartSrc are required');
  if (!Array.isArray(bars) || !bars.length) throw new Error('buildStandaloneHTML: bars are required');
  if (!chartSrc.includes(IMPORT_LINE)) {
    throw new Error(`buildStandaloneHTML: the chart module no longer contains "${IMPORT_LINE}" — update the rewrite`);
  }
  const title = String(meta.title || meta.label || 'WickChart');
  const payload = jsonForScript({ v: 1, meta, state, bars });
  // `<` is escaped inside both module strings — a raw `</script` inside a
  // source (in a comment, say) cannot terminate the bootstrap block
  const coreLit = JSON.stringify(coreSrc).replace(/</g, '\\u003C');
  const chartLit = JSON.stringify(chartSrc).replace(/</g, '\\u003C');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, '&lt;')}</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0d12; }
  body { display: flex; flex-direction: column; }
  wick-chart { flex: 1; width: 100%; }
  footer { font: 12px/1.6 system-ui, sans-serif; color: #8b949e; text-align: center; padding: 8px; }
  footer a { color: #4c8dff; }
</style>
</head>
<body>
<wick-chart id="chart"></wick-chart>
<footer>${title.replace(/</g, '&lt;')} — a self-contained chart shared as one file · <a href="https://github.com/benyblack/wickchart">made with WickChart</a></footer>
<script id="${PAYLOAD_ID}" type="application/json">${payload}</script>
<script type="module">
const CORE_SRC = ${coreLit};
const CHART_SRC = ${chartLit};
const b64 = (s) => 'data:text/javascript;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(s)));
const coreUrl = b64(CORE_SRC);
const chartUrl = b64(CHART_SRC.replace(${JSON.stringify(IMPORT_LINE)}, 'from ' + JSON.stringify(coreUrl)));
const { state, bars } = JSON.parse(document.getElementById(${JSON.stringify(PAYLOAD_ID)}).textContent);
await import(chartUrl); // registers <wick-chart> as a side effect
const el = document.getElementById('chart');
if (state) el.setState(state); // the pending-range mechanism applies the view after setData
el.setData(bars);
</script>
</body>
</html>
`;
}

/** Find the library's module URLs the way the page actually loaded them. */
function discoverModuleUrls() {
  const names = performance.getEntriesByType('resource').map((r) => r.name);
  const chartUrl = names.filter((n) => /(^|\/)wick-chart\.js$/.test(new URL(n, location.href).pathname)).pop();
  if (!chartUrl) return null;
  return { chartUrl: new URL(chartUrl, location.href).href, coreUrl: new URL('./core.js', chartUrl).href };
}

export function attachShare(chart, opts = {}) {
  if (!chart || typeof chart.setData !== 'function') {
    throw new TypeError('attachShare(chart): the chart element is required');
  }
  const fetchText = (u) => fetch(u).then((r) => {
    if (!r.ok) throw new Error(`attachShare: fetching ${u} failed (${r.status})`);
    return r.text();
  });

  /**
   * The standalone HTML for the chart's current state and data.
   * @param {{sources?: {coreSrc: string, chartSrc: string}, meta?: object}} [o]
   */
  async function exportChart(o = {}) {
    const sources = o.sources || opts.sources;
    const urls = opts.coreUrl && opts.chartUrl
      ? { coreUrl: opts.coreUrl, chartUrl: opts.chartUrl }
      : discoverModuleUrls();
    let coreSrc, chartSrc;
    if (sources) {
      ({ coreSrc, chartSrc } = sources);
    } else if (urls) {
      [coreSrc, chartSrc] = await Promise.all([fetchText(urls.coreUrl), fetchText(urls.chartUrl)]);
    } else {
      throw new Error(
        'exportChart: could not locate the wickchart modules (resource timing has no wick-chart.js). ' +
          'Pass attachShare(chart, { coreUrl, chartUrl }) or exportChart({ sources }).'
      );
    }
    return buildStandaloneHTML({
      coreSrc,
      chartSrc,
      bars: chart.data,
      state: chart.getState(),
      meta: { label: chart.getAttribute('label') || undefined, exported: new Date().toISOString(), ...o.meta },
    });
  }

  /** Compose and trigger the download (browser only). */
  async function downloadChart(filename = 'wickchart.html', o = {}) {
    const html = await exportChart(o);
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return html;
  }

  const api = { exportChart, downloadChart, parseChartFile, detach() { delete chart.exportChart; delete chart.downloadChart; } };
  chart.exportChart = exportChart;
  chart.downloadChart = downloadChart;
  return api;
}
