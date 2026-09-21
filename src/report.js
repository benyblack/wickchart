/* ==========================================================================
 * <wick-chart> report export — the branded snapshot: chart + visible-range
 * stats + watermark, composed into one shareable PNG.
 *
 *   import { exportReport, downloadReport } from 'wickchart/report';
 *
 *   const url = await exportReport(chart);          // PNG data URL
 *   const blob = await exportReport(chart, { as: 'blob' });
 *   await downloadReport(chart, 'btc-1h.png');      // triggers a download
 *
 * Composes from public surfaces only — exportPNG() (the DPR-crisp canvas),
 * getVisibleRange(), the chart's own --wick-* CSS variables for theming —
 * so there are zero core changes. The model (title, stats rows, layout,
 * colors, formatting) is plain data built by reportModel() and unit-tested
 * in Node; only the actual canvas composition needs a browser.
 *
 * Options: title (default: the chart's label attribute), source (a string
 * credited in the footer, e.g. 'binance: BTCUSDT'), brand ('WickChart'),
 * theme ('dark' | 'light' | 'auto' — auto also follows a registered
 * registerTheme() theme beneath the chart's CSS variables),
 * scale (1..4, default 2), precision (price decimals, default derived),
 * as ('url' | 'blob' | 'canvas').
 * ========================================================================== */

import { computeStats, getTheme } from './core.js';

/* ---------------- layout constants (CSS px, pre-scale) ---------------- */

const HEADER_H = 64;
const STATS_H = 104;
const FOOTER_H = 40;
const PAD = 18;
const GRID_COLS = 4;
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/* ---------------- pure helpers ---------------- */

/** Decimals worth showing for a price of this magnitude. */
export function decimalsFor(price) {
  const p = Math.abs(Number(price));
  if (!Number.isFinite(p) || p === 0) return 2;
  if (p >= 10000) return 2;
  if (p >= 100) return 2;
  if (p >= 1) return 3;
  return 6;
}

/** 1234 → '1.2k', 1234567 → '1.23M', 12 → '12'. */
export function compact(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

export function pct(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(digits) + '%';
}

const fmtDate = (t) =>
  Number.isFinite(t)
    ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';

/** Greatest index whose time is <= t (binary search; bars are ascending). */
export function indexForTime(bars, t) {
  let lo = 0;
  let hi = bars.length - 1;
  if (t < bars[0].time) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const PALETTES = {
  dark: {
    bg: '#0d1117', panel: '#11141c', text: '#e6edf3', muted: '#8b949e',
    up: '#16c784', down: '#ea3943', accent: '#4c8dff',
  },
  light: {
    bg: '#ffffff', panel: '#f4f6f9', text: '#111827', muted: '#6b7280',
    up: '#0e9f6e', down: '#e02424', accent: '#2563eb',
  },
};

/** Resolve the report colors: theme palettes, overridden by a registered
 *  registerTheme() theme (in auto mode) and then the chart's own --wick-*
 *  variables when readable (browser) and theme is 'auto'. */
export function reportColors(chart, theme = 'auto') {
  const key = theme === 'light' || theme === 'dark' ? theme : 'auto';
  const pal = { ...PALETTES[key === 'auto' ? 'dark' : key] };
  let seeded = false;
  if (key === 'auto') {
    const name = chart && chart.theme;
    const t = name && name !== 'light' && name !== 'dark' ? getTheme(name) : null;
    if (t) {
      pal.bg = t.bg; pal.text = t.textStrong; pal.muted = t.text;
      pal.up = t.up; pal.down = t.down; pal.accent = t.accent;
      seeded = true;
    }
  }
  if (key === 'auto' && typeof getComputedStyle === 'function' && chart && chart.nodeType) {
    const cs = getComputedStyle(chart);
    const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    pal.bg = v('--wick-bg', pal.bg);
    pal.text = v('--wick-text-strong', pal.text);
    pal.muted = v('--wick-text', pal.muted);
    pal.up = v('--wick-up', pal.up);
    pal.down = v('--wick-down', pal.down);
    pal.accent = v('--wick-accent', pal.accent);
  }
  // a light chart background flips the panel/band contrast to match
  if (key === 'auto') {
    pal.light = luminance(pal.bg) > 0.5;
    if (pal.light) {
      pal.panel = PALETTES.light.panel; if (!seeded) pal.muted = PALETTES.light.muted;
    } else {
      pal.panel = PALETTES.dark.panel;
    }
  } else {
    pal.panel = PALETTES[key].panel;
  }
  return pal;
}

/** Relative luminance of a #hex / rgb() string (0..1, best effort). */
export function luminance(color) {
  const m = /#([0-9a-f]{6})/i.exec(String(color || ''));
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/* ---------------- the model (pure, Node-testable) ---------------- */

/**
 * Build the whole report as data: sizes, bands, stat rows, colors, labels.
 * @param {object} chart a <wick-chart> (public API only: data,
 *   getVisibleRange, exportPNG, clientWidth/Height, getAttribute)
 * @param {{title?: string, source?: string, brand?: string, theme?: string,
 *   scale?: number, precision?: number}} [opts]
 */
export function reportModel(chart, opts = {}) {
  const d = chart && chart.data;
  if (!Array.isArray(d) || d.length < 2) {
    throw new Error('exportReport(chart): the chart needs data (2+ bars)');
  }
  const range = typeof chart.getVisibleRange === 'function' ? chart.getVisibleRange() : null;
  if (!range) throw new Error('exportReport(chart): the chart needs a rendered view');
  const i0 = indexForTime(d, range.from);
  const i1 = indexForTime(d, range.to);
  const dt = d.length > 1 ? d[i1].time - d[i1 - 1].time : 3600e3;
  const stats = computeStats(d, i0, i1, dt) || computeStats(d, 0, d.length - 1, dt);
  const precision =
    Number.isInteger(opts.precision) && opts.precision >= 0 && opts.precision <= 10
      ? opts.precision
      : decimalsFor(stats.max);
  const last = d[d.length - 1].close;

  const rows = [
    { label: 'Return', value: pct(stats.changePct), color: stats.changePct >= 0 ? 'up' : 'down' },
    { label: 'Ann. vol', value: stats.annVolPct.toFixed(1) + '%' },
    { label: 'Max drawdown', value: '-' + stats.maxDDPct.toFixed(1) + '%', color: 'down' },
    { label: 'Bars', value: String(stats.n) },
    { label: 'Up / down', value: stats.up + ' / ' + stats.dn },
    { label: 'Avg volume', value: compact(stats.avgVolume) },
    { label: 'High', value: stats.max.toFixed(precision), color: 'up' },
    { label: 'Low', value: stats.min.toFixed(precision), color: 'down' },
  ];

  const s = Number(opts.scale);
  const scale = Number.isFinite(s) && s > 0 ? Math.max(1, Math.min(4, Math.round(s))) : 2;
  const chartW = Math.max(320, Math.round(chart.clientWidth || 900));
  const chartH = Math.max(160, Math.round(chart.clientHeight || 420));
  const title =
    (typeof opts.title === 'string' && opts.title.trim()) ||
    (typeof chart.getAttribute === 'function' ? chart.getAttribute('label') : '') ||
    'WickChart';
  return {
    scale,
    width: chartW,
    height: HEADER_H + chartH + STATS_H + FOOTER_H,
    bands: { header: HEADER_H, stats: STATS_H, footer: FOOTER_H, chart: chartH },
    grid: { cols: GRID_COLS },
    title,
    brand: (typeof opts.brand === 'string' && opts.brand.trim()) || 'WickChart',
    source: typeof opts.source === 'string' ? opts.source : '',
    range: { from: range.from, to: range.to },
    last,
    precision,
    rows,
    generatedAt: Date.now(),
    colors: reportColors(chart, opts.theme),
    stats,
  };
}

/* ---------------- the composition (browser) ---------------- */

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('exportReport: the chart PNG failed to decode'));
    img.src = src;
  });

/**
 * Compose the branded report and return it as a PNG data URL (default), a
 * Blob, or the canvas itself.
 * @returns {Promise<string|Blob|HTMLCanvasElement>}
 */
export async function exportReport(chart, opts = {}) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    throw new Error('exportReport requires a browser (canvas + Image)');
  }
  const model = reportModel(chart, opts);
  const img = await loadImage(chart.exportPNG());
  const { width, height, scale, colors: pal } = model;

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const b = model.bands;

  // header band
  ctx.fillStyle = pal.panel;
  ctx.fillRect(0, 0, width, b.header);
  ctx.fillStyle = pal.text;
  ctx.font = '700 22px ' + FONT;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(model.title, PAD, 34);
  ctx.fillStyle = pal.muted;
  ctx.font = '400 12px ' + FONT;
  const sub = fmtDate(model.range.from) + '  →  ' + fmtDate(model.range.to);
  ctx.fillText(sub, PAD, 52);
  ctx.textAlign = 'right';
  ctx.fillStyle = pal.accent;
  ctx.font = '700 14px ' + FONT;
  ctx.fillText(model.brand, width - PAD, 30);
  ctx.fillStyle = pal.muted;
  ctx.font = '400 11px ' + FONT;
  ctx.fillText('last ' + model.last.toFixed(model.precision), width - PAD, 48);
  ctx.textAlign = 'left';

  // chart image (full-res source drawn into the band — stays crisp)
  ctx.drawImage(img, 0, b.header, width, b.chart);
  // watermark over the chart's bottom-right corner
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = pal.muted;
  ctx.font = '600 13px ' + FONT;
  ctx.textAlign = 'right';
  ctx.fillText(model.brand, width - PAD - 6, b.header + b.chart - 10);
  ctx.restore();

  // stats band — a grid of label-over-value cards
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, b.header + b.chart, width, b.stats);
  const cols = model.grid.cols;
  const cw = (width - PAD * 2) / cols;
  const rows = Math.ceil(model.rows.length / cols);
  const rh = (b.stats - 16) / rows;
  model.rows.forEach((r, i) => {
    const cx = PAD + (i % cols) * cw;
    const cy = b.header + b.chart + 8 + Math.floor(i / cols) * rh;
    ctx.fillStyle = pal.muted;
    ctx.font = '500 10px ' + FONT;
    ctx.fillText(r.label.toUpperCase(), cx, cy + 12);
    ctx.fillStyle = r.color === 'up' ? pal.up : r.color === 'down' ? pal.down : pal.text;
    ctx.font = '700 15px ' + FONT;
    ctx.fillText(r.value, cx, cy + 32);
  });

  // footer band
  ctx.fillStyle = pal.panel;
  ctx.fillRect(0, height - b.footer, width, b.footer);
  ctx.fillStyle = pal.muted;
  ctx.font = '400 11px ' + FONT;
  const credit = 'Generated with ' + model.brand + (model.source ? ' · ' + model.source : '');
  ctx.fillText(credit + ' · ' + fmtDate(model.generatedAt), PAD, height - 16);
  ctx.textAlign = 'right';
  ctx.fillText(model.stats.n + ' bars · wickchart', width - PAD, height - 16);
  ctx.textAlign = 'left';

  const as = opts.as || 'url';
  if (as === 'canvas') return canvas;
  if (as === 'blob') {
    return new Promise((resolve, reject) =>
      canvas.toBlob((bl) => (bl ? resolve(bl) : reject(new Error('exportReport: toBlob failed'))), 'image/png')
    );
  }
  return canvas.toDataURL('image/png');
}

/**
 * Compose and trigger a download (browser only).
 * @returns {Promise<void>}
 */
export async function downloadReport(chart, filename = 'wickchart-report.png', opts = {}) {
  const blob = await exportReport(chart, { ...opts, as: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
