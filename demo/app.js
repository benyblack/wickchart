/* WickChart demo — data feeds & UI wiring around <wick-chart>. */
import WickChart from '../src/wick-chart.js';
import { encodeStateQuery, decodeStateQuery, splitIndicatorTokens, compileScript } from '../src/core.js';
import { attachDrawings } from '../plugins/draw/draw.mjs';
import { attachSessions } from '../plugins/sessions/sessions.mjs';
import { attachReplay } from '../plugins/replay/replay.mjs';
import { attachCompare } from '../plugins/compare/compare.mjs';
import { attachNavigator } from '../plugins/navigator/navigator.mjs';
import { attachAlertsPlus } from '../plugins/alerts-plus/alerts-plus.mjs';
import { attachLayouts } from '../plugins/layouts/layouts.mjs';
import { attachSignals } from '../plugins/signals/signals.mjs';
import { attachTape } from '../plugins/tape/tape.mjs';
import { attachNarrator } from '../plugins/narrator/narrator.mjs';
import { attachScenario } from '../plugins/scenario/scenario.mjs';
import { attachAI } from '../plugins/ai/ai.mjs';
import {
  genSynthetic,
  makeSynthStream,
  fetchBinanceKlines,
  openBinanceSocket,
  BASE_PRICES,
} from '../src/feeds.js';

/* ------------------------------------------------------------------ *
 * VWAP used to be the reference custom indicator here — it's a native
 * built-in since the indicators batch (see BUILTIN_INDICATORS in core.js).
 * The `WickChart.registerIndicator()` extension point it showcased is
 * still available and documented in the docs (Indicators section).
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

const SYMBOLS = [
  { id: 'DEMO', label: 'Demo' },
  { id: 'BTC', label: 'BTC' },
  { id: 'ETH', label: 'ETH' },
  { id: 'SOL', label: 'SOL' },
];

const TFS = [
  { id: '15m', sec: 15 * 60, label: '15m' },
  { id: '1h', sec: 3600, label: '1h' },
  { id: '4h', sec: 4 * 3600, label: '4h' },
  { id: '1D', sec: 24 * 3600, label: '1D' },
];

const BINANCE = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };

const INDICATORS = [
  { id: 'sma:20', label: 'SMA 20', color: '#f0b429' },
  { id: 'ema:50', label: 'EMA 50', color: '#38bdf8' },
  { id: 'bb:20', label: 'BB 20', color: '#e64980' },
  { id: 'vwap', label: 'VWAP', color: '#22d3ee' },
  { id: 'supertrend:10/3', label: 'ST 10', color: '#fb7185' },
  { id: 'donchian:20', label: 'DON 20', color: '#94a3b8' },
  { id: 'rsi:14', label: 'RSI 14', color: '#a78bfa' },
  { id: 'macd:12/26/9', label: 'MACD', color: '#34d399' },
  { id: 'stoch:14/3', label: 'STOCH', color: '#fbbf24' },
  { id: 'atr:14', label: 'ATR 14', color: '#4ade80' },
  { id: 'volume', label: 'Volume', color: '#7c8598' },
];

const state = {
  symbol: 'DEMO',
  tf: '1h',
  type: 'candles',
  live: true,
  theme: 'dark',
  stats: false,
  profile: false,
  annotations: false,
  volshading: false,
  indicators: new Set(['volume']),
  scripts: new Set(),
};

const chart = document.getElementById('chart');

/* The 2.0 path: guided playback (narrate/walk/sonify/story), planning
 * (scenario/risk plan) and the agent surface come from their packages —
 * attaching shadows the core's identical methods, so every button below
 * already exercises the plugin code the 2.0 cut makes canonical. */
attachNarrator(chart);
attachScenario(chart);
attachAI(chart);

/* ------------------------------------------------------------------ *
 * Synthetic data (works fully offline)
 * ------------------------------------------------------------------ */

const HIST_LEN = 2600; // long synthetic history; the chart loads it in chunks
const CHUNK = 500; // initial slice handed to the chart
const histCache = new Map();

function historyKey(symbol, tfId) {
  return symbol + ':' + tfId;
}

/** Long synthetic history for a symbol+timeframe (generated once). */
function getHistory(symbol, tfId) {
  const key = historyKey(symbol, tfId);
  let hist = histCache.get(key);
  if (!hist) {
    const tfSec = TFS.find((t) => t.id === tfId).sec;
    hist = genSynthetic(symbol, tfSec, HIST_LEN, BASE_PRICES[symbol] || 100);
    histCache.set(key, hist);
  }
  return hist;
}

/** Older synthetic bars preceding `fromTime` (for chart.onloadmore). */
function olderSynthetic(symbol, tfId, fromTime, limit = CHUNK) {
  const hist = getHistory(symbol, tfId);
  const older = hist.filter((b) => b.time < fromTime);
  return older.slice(-limit);
}

/* ------------------------------------------------------------------ *
 * Binance feed (real data, graceful fallback)
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Feed controller
 * ------------------------------------------------------------------ */

let feed = null;

const lastChartClose = () => {
  const d = chart.data;
  return d.length ? d[d.length - 1].close : undefined;
};

function stopFeed() {
  if (feed) {
    feed.stop();
    feed = null;
  }
}

function startFeed({ syntheticFallbackToast = false } = {}) {
  stopFeed();
  const { symbol, tf, live } = state;
  if (!live) return;

  if (symbol === 'DEMO' || !BINANCE[symbol]) {
    const sec = TFS.find((t) => t.id === tf).sec;
    const next = makeSynthStream(sec, lastChartClose());
    const timer = setInterval(() => chart.update(next()), 650);
    setStatus('ok', 'live · synthetic feed');
    feed = { stop: () => clearInterval(timer) };
    return;
  }

  setStatus('warn', 'connecting to Binance…');
  let pollTimer = null;
  let ws = null;
  let dead = false;

  const startPolling = () => {
    if (dead || pollTimer) return;
    setStatus('warn', 'live · polling Binance');
    pollTimer = setInterval(async () => {
      try {
        const bars = await fetchBinanceKlines(BINANCE[symbol], tf, 2);
        for (const b of bars) chart.update(b);
      } catch (_) {
        clearInterval(pollTimer);
        pollTimer = null;
        useSynthetic('Live connection lost — switched to synthetic data.');
      }
    }, 10000);
  };

  const useSynthetic = (msg) => {
    if (dead) return;
    if (syntheticFallbackToast || msg) toast(msg || 'Binance unreachable — showing synthetic data.');
    const sec = TFS.find((t) => t.id === tf).sec;
    const next = makeSynthStream(sec, lastChartClose());
    const timer = setInterval(() => chart.update(next()), 650);
    setStatus('warn', 'live · synthetic (Binance unreachable)');
    feed = { stop: () => clearInterval(timer) };
    if (ws) { ws.close(); ws = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };

  ws = openBinanceSocket(
    BINANCE[symbol],
    tf,
    (bar) => {
      if (dead) return;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      setStatus('ok', `live · Binance ${BINANCE[symbol]}`);
      chart.update(bar);
    },
    () => {
      if (dead) return;
      startPolling();
    }
  );

  feed = {
    stop() {
      dead = true;
      if (ws) ws.close();
      if (pollTimer) clearInterval(pollTimer);
    },
  };
}

async function loadSymbol() {
  const { symbol, tf } = state;
  chart.setAttribute('label', `${symbol} · ${tf}`);

  if (symbol === 'DEMO' || !BINANCE[symbol]) {
    chart.onloadmore = (fromTime) => olderSynthetic(symbol, tf, fromTime);
    chart.setData(getHistory(symbol, tf).slice(-CHUNK));
    startFeed();
    applyZonesIfOn();
    return;
  }

  setStatus('warn', `loading ${BINANCE[symbol]} ${tf}…`);
  try {
    const bars = await fetchBinanceKlines(BINANCE[symbol], tf);
    chart.onloadmore = (fromTime) => fetchBinanceKlines(BINANCE[symbol], tf, CHUNK, fromTime);
    chart.setData(bars);
    startFeed({ syntheticFallbackToast: true });
  } catch (err) {
    toast(`Couldn't reach Binance (${err.message}) — showing synthetic data.`);
    chart.onloadmore = (fromTime) => olderSynthetic(symbol, tf, fromTime);
    chart.setData(getHistory(symbol, tf).slice(-CHUNK));
    startFeed();
  }
  applyZonesIfOn();
}

/* ------------------------------------------------------------------ *
 * UI helpers
 * ------------------------------------------------------------------ */

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const rangeText = document.getElementById('range-text');

function setStatus(kind, text) {
  statusDot.className = 'dot ' + kind;
  statusText.textContent = text;
}

const fmtDate = (t) =>
  new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

chart.addEventListener('wick:range', (e) => {
  rangeText.textContent = `${fmtDate(e.detail.from)} → ${fmtDate(e.detail.to)}`;
});

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 300ms';
    setTimeout(() => el.remove(), 350);
  }, 4200);
}

function buildSeg(container, items, getActive, onSelect) {
  container.innerHTML = '';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label ?? item.id;
    btn.dataset.id = item.id;
    btn.setAttribute('aria-pressed', String(getActive() === item.id));
    btn.classList.toggle('active', getActive() === item.id);
    btn.addEventListener('click', () => {
      onSelect(item.id);
      for (const b of container.children) {
        const on = b.dataset.id === item.id;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      }
    });
    container.appendChild(btn);
  }
}

function applyIndicators() {
  chart.setAttribute('indicators', [...state.indicators, ...state.scripts].join(' '));
}

/* ---------------- URL sharing ---------------- */

let hashTimer = 0;

function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const chartState = chart.getState();
    const q = new URLSearchParams(
      encodeStateQuery({ ...chartState, indicators: [...state.indicators, ...state.scripts].join(' ') })
    );
    q.set('sym', state.symbol);
    q.set('tf', state.tf);
    history.replaceState(null, '', '#' + q.toString());
  }, 250);
}

function readHash() {
  if (!location.hash || location.hash.length < 2) return null;
  const p = new URLSearchParams(location.hash.slice(1));
  const sym = p.get('sym');
  if (sym && SYMBOLS.some((s) => s.id === sym)) state.symbol = sym;
  const tf = p.get('tf');
  if (tf && TFS.some((t) => t.id === tf)) state.tf = tf;
  const s = decodeStateQuery(location.hash.slice(1));
  if (s.type && ['candles', 'line', 'area', 'bars', 'hollow', 'heikin'].includes(s.type)) state.type = s.type;
  if (s.theme === 'light' || s.theme === 'dark') state.theme = s.theme;
  if (typeof s.stats === 'boolean') state.stats = s.stats;
  if (typeof s.profile === 'boolean') state.profile = s.profile;
  if (typeof s.annotations === 'boolean') state.annotations = s.annotations;
  if (s.volshading) state.volshading = true; // boolean or custom "p1/p2" string
  if (s.indicators) {
    state.indicators = new Set();
    state.scripts = new Set();
    for (const tok of splitIndicatorTokens(s.indicators)) {
      const m = tok.match(/^(p?expr):\{([^{}]*)\}(@\S*)?$/i);
      if (m) {
        try {
          compileScript(m[2]); // invalid scripts from URLs are dropped, never rendered
          state.scripts.add(tok);
        } catch (err) {
          /* ignore */
        }
      } else if (INDICATORS.some((i) => i.id === tok)) {
        state.indicators.add(tok);
      }
    }
    // the chart gets exactly the validated tokens (chips and chart stay in sync)
    s.indicators = [...state.indicators, ...state.scripts].join(' ') || undefined;
  }
  return s;
}

chart.addEventListener('wick:range', writeHash);

/* ---------------- build controls ---------------- */

const hashState = readHash();

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  chart.setAttribute('theme', state.theme);
  document.getElementById('ico-moon').style.display = state.theme === 'dark' ? '' : 'none';
  document.getElementById('ico-sun').style.display = state.theme === 'light' ? '' : 'none';
}

if (hashState) {
  chart.setState(hashState); // may stash a pending view until data loads
}
applyTheme();

buildSeg(document.getElementById('seg-symbol'), SYMBOLS, () => state.symbol, (id) => {
  state.symbol = id;
  loadSymbol();
  writeHash();
});

buildSeg(document.getElementById('seg-tf'), TFS, () => state.tf, (id) => {
  state.tf = id;
  loadSymbol();
  writeHash();
});

const segType = document.getElementById('seg-type');
for (const b of segType.children) {
  const on = b.dataset.type === state.type;
  b.classList.toggle('active', on);
  b.setAttribute('aria-pressed', String(on));
}
segType.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-type]');
  if (!btn) return;
  state.type = btn.dataset.type;
  chart.setAttribute('type', state.type);
  for (const b of segType.children) {
    const on = b.dataset.type === state.type;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  writeHash();
});

const chips = document.getElementById('chips');
for (const ind of INDICATORS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.innerHTML = `<i style="background:${ind.color}"></i>${ind.label}`;
  btn.setAttribute('aria-pressed', String(state.indicators.has(ind.id)));
  btn.classList.toggle('on', state.indicators.has(ind.id));
  btn.addEventListener('click', () => {
    if (state.indicators.has(ind.id)) state.indicators.delete(ind.id);
    else state.indicators.add(ind.id);
    btn.classList.toggle('on', state.indicators.has(ind.id));
    btn.setAttribute('aria-pressed', String(state.indicators.has(ind.id)));
    applyIndicators();
    writeHash();
  });
  chips.appendChild(btn);
}

/* ---------------- custom WickScript indicators ---------------- */

const scriptChips = document.getElementById('script-chips');
const scriptInput = document.getElementById('script-input');
const scriptPane = document.getElementById('script-pane');
const scriptError = document.getElementById('script-error');

function renderScriptChips() {
  scriptChips.textContent = '';
  for (const tok of state.scripts) {
    const m = tok.match(/^(p?expr):\{([^{}]*)\}/i);
    const src = m ? m[2].trim() : tok;
    const label = src.length > 22 ? src.slice(0, 21) + '…' : src;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'on';
    btn.title = src + ' — click to remove';
    btn.appendChild(document.createElement('i'));
    btn.appendChild(
      document.createTextNode((m && m[1].toLowerCase() === 'pexpr' ? 'pane · ' : '') + label)
    );
    btn.addEventListener('click', () => {
      state.scripts.delete(tok);
      renderScriptChips();
      applyIndicators();
      writeHash();
    });
    scriptChips.appendChild(btn);
  }
}

function addScript() {
  const src = scriptInput.value.trim();
  scriptError.textContent = '';
  if (!src) return;
  try {
    compileScript(src);
  } catch (err) {
    scriptError.textContent = err.message.replace(/^script:\s*/, '');
    return;
  }
  state.scripts.add((scriptPane.checked ? 'pexpr:{' : 'expr:{') + src + '}');
  scriptInput.value = '';
  renderScriptChips();
  applyIndicators();
  writeHash();
}

document.getElementById('script-add').addEventListener('click', addScript);
scriptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addScript();
});
renderScriptChips();

document.getElementById('btn-live').addEventListener('click', (e) => {
  state.live = !state.live;
  e.currentTarget.setAttribute('aria-pressed', String(state.live));
  document.getElementById('live-label').textContent = state.live ? 'Live' : 'Paused';
  if (state.live) startFeed();
  else {
    stopFeed();
    setStatus('off', 'paused');
  }
});

document.getElementById('btn-sonify').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', String(on));
  document.getElementById('chart').setAttribute('sonify', String(on));
  toast(
    on
      ? 'Sound on — hover or use arrow keys to hear the price as pitch.'
      : 'Sound off.'
  );
});

document.getElementById('btn-play').addEventListener('click', () => {
  document.getElementById('chart').playRange();
});

/* ---------------- AI-ready summary (local, no network) ---------------- */

const explainPanel = document.getElementById('explain-panel');
const explainText = document.getElementById('explain-text');

document.getElementById('btn-explain').addEventListener('click', () => {
  const s = chart.getDataWindow();
  explainText.textContent = s ? s.text : 'No data — load a chart first.';
  explainPanel.hidden = false;
});
document.getElementById('explain-close').addEventListener('click', () => {
  explainPanel.hidden = true;
});
document.getElementById('explain-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(explainText.textContent);
    toast('Summary copied — paste it into any AI chat.');
  } catch (err) {
    toast('Copy blocked — select the text and copy manually.');
  }
});

document.getElementById('btn-coview').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', String(on));
  const chartEl = document.getElementById('chart');
  if (on) {
    chartEl.setAttribute('co-view-name', 'tab-' + Math.random().toString(36).slice(2, 5));
    chartEl.setAttribute('co-view', 'wick-demo');
    draw.setShare(true);
  } else {
    chartEl.removeAttribute('co-view');
    chartEl.removeAttribute('co-view-name');
    draw.setShare(null);
  }
  toast(
    on
      ? 'Co-view on — open this page in a second tab: crosshairs sync, viewports show as bands, and drawings appear on both charts.'
      : 'Co-view off.'
  );
});

chart.addEventListener('wick:peers', (e) => {
  const { joined, left } = e.detail;
  const who = (p) => p.name || p.id;
  if (joined.length) toast(`${who(joined[0])} joined co-view — their viewport shows as a band at the top.`);
  if (left.length) toast(`${who(left[0])} left co-view.`);
});

/* Bar-walk narrator — replay history while the footer narrates events. */
const walkCaption = document.getElementById('walk-caption');
document.getElementById('btn-walk').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  if (btn.getAttribute('aria-pressed') === 'true') {
    chart.stopWalk();
    return;
  }
  const d = chart.data;
  if (!d.length) return;
  btn.setAttribute('aria-pressed', 'true');
  chart.walk({ from: Math.max(0, d.length - 400), speed: 90 });
});
chart.addEventListener('wick:walk', (e) => {
  const { phase, index, events, from, to } = e.detail;
  if (phase === 'stop' || phase === 'end') {
    walkCaption.hidden = true;
    document.getElementById('btn-walk').setAttribute('aria-pressed', 'false');
    if (phase === 'end') toast('Walk finished — the story of the last 400 bars.');
    return;
  }
  const parts = events.map((ev) => `${ev.type === 'leg' ? (ev.legPct >= 0 ? '▲' : '▼') + ev.note : ev.note}`);
  walkCaption.hidden = false;
  walkCaption.textContent =
    `walking ${index - from}/${to - from} — ` +
    (parts.length ? parts.join(' · ') : '…');
});

/* Delta brush — drag-select a bar range for Δ%, extremes and summed volume. */
document.getElementById('btn-brush').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', String(on));
  if (on) chart.setAttribute('brush', '');
  else chart.removeAttribute('brush');
  toast(on ? 'Brush on — drag across bars to measure a range. Esc clears.' : 'Brush off.');
});
chart.addEventListener('wick:brush', (e) => {
  const s = e.detail;
  const sign = s.delta >= 0 ? '+' : '';
  toast(`Brush ${s.bars} bars: ${sign}${s.deltaPct.toFixed(2)}% (H ${s.high.toFixed(2)} · L ${s.low.toFixed(2)} · Σvol ${Math.round(s.volume)})`);
});

/* Story mode — a guided tour built from the data itself. */
function demoStory() {
  const d = chart.data;
  if (!d || d.length < 60) return null;
  const last = d.length - 1;
  const T = (i) => d[Math.max(0, Math.min(last, i))].time;
  const events = chart.narrate({ from: d[0].time, to: d[last].time });
  const spike = events.find((ev) => ev.type === 'volspike');
  const scenes = [
    { title: 'Act I — the full picture', note: `${d.length} bars. See the shape before the details.`, range: { from: d[0].time, to: d[last].time } },
  ];
  if (spike) {
    scenes.push({
      title: 'Act II — the volume spike',
      note: spike.note,
      range: { from: T(spike.i - 40), to: T(spike.i + 20) },
      indicators: 'volume',
    });
  }
  scenes.push({
    title: 'Act III — the recent trend',
    note: 'SMA 20 and RSI 14 join for the last 120 bars.',
    range: { from: T(last - 120), to: d[last].time },
    indicators: 'sma:20 rsi:14',
  });
  const entry = d[last].close;
  const recent = d.slice(-20).map((b) => b.low);
  scenes.push({
    title: 'Act IV — the plan',
    note: 'A bull scenario into future space plus a 1R/2R/3R grid.',
    range: { from: T(last - 80), to: d[last].time },
    indicators: 'sma:20',
    scenario: demoScenario(),
    riskPlan: { entry, stop: Math.min(entry * 0.982, Math.min(...recent)), multiples: [1, 2, 3], label: 'demo plan' },
  });
  return scenes;
}

let storyRunning = false;
document.getElementById('btn-story').addEventListener('click', () => {
  if (storyRunning) {
    chart.stopStory();
    return;
  }
  const story = demoStory();
  if (story) chart.playStory(story, { dwell: 2400 });
});
chart.addEventListener('wick:story', (e) => {
  const { phase, title, note, index, total } = e.detail;
  if (phase === 'scene') {
    storyRunning = true;
    document.getElementById('btn-story').setAttribute('aria-pressed', 'true');
    walkCaption.hidden = false;
    walkCaption.textContent = `story ${index + 1}/${total} — ${title}: ${note}`;
  } else {
    storyRunning = false;
    document.getElementById('btn-story').setAttribute('aria-pressed', 'false');
    walkCaption.hidden = true;
    if (phase === 'end') toast('Story finished.');
  }
});

document.getElementById('btn-annotations').setAttribute('aria-pressed', String(state.annotations));
if (state.annotations) chart.setAttribute('annotations', 'true');
document.getElementById('btn-annotations').addEventListener('click', (e) => {
  state.annotations = !state.annotations;
  chart.setAttribute('annotations', String(state.annotations));
  e.currentTarget.setAttribute('aria-pressed', String(state.annotations));
  writeHash();
});

document.getElementById('btn-profile').setAttribute('aria-pressed', String(state.profile));
if (state.profile) chart.setAttribute('profile', 'true');
document.getElementById('btn-profile').addEventListener('click', (e) => {
  state.profile = !state.profile;
  chart.setAttribute('profile', String(state.profile));
  e.currentTarget.setAttribute('aria-pressed', String(state.profile));
  writeHash();
});

document.getElementById('btn-stats').setAttribute('aria-pressed', String(state.stats));
if (state.stats) chart.setAttribute('stats', 'true');
document.getElementById('btn-stats').addEventListener('click', (e) => {
  state.stats = !state.stats;
  chart.setAttribute('stats', String(state.stats));
  e.currentTarget.setAttribute('aria-pressed', String(state.stats));
  writeHash();
});

document.getElementById('btn-volshading').setAttribute('aria-pressed', String(state.volshading));
if (state.volshading) chart.setAttribute('volshading', 'true');
document.getElementById('btn-volshading').addEventListener('click', (e) => {
  state.volshading = !state.volshading;
  chart.setAttribute('volshading', String(state.volshading));
  e.currentTarget.setAttribute('aria-pressed', String(state.volshading));
  writeHash();
});

/* Server-side overlays demo — the shape an analysis API would return:
 * stacked supply/demand zones anchored in time (extending into future space)
 * plus horizontal support levels. */
let zonesOn = false;

function demoOverlays() {
  const d = chart.data;
  if (!d || d.length < 30) return [];
  const at = (frac) => d[Math.floor(d.length * frac)];
  const hi = at(0.7);
  const lo = at(0.72);
  const from = at(0.55).time;
  const fromLate = at(0.62).time;
  const s1 = at(0.3).low;
  const s2 = at(0.15).low;
  return [
    { type: 'zone', from, priceFrom: hi.high, priceTo: hi.high * 1.018, color: '#26a69a', alpha: 0.22, label: 'supply' },
    { type: 'zone', from: fromLate, priceFrom: hi.high * 1.018, priceTo: hi.high * 1.038, color: '#26a69a', alpha: 0.22 },
    { type: 'zone', from, priceFrom: lo.low * 0.982, priceTo: lo.low, color: '#ef5350', alpha: 0.22, label: 'demand' },
    { type: 'zone', from: fromLate, priceFrom: lo.low * 0.962, priceTo: lo.low * 0.982, color: '#ef5350', alpha: 0.22 },
    { type: 'level', price: s1, color: '#3f51b5', label: 'S1' },
    { type: 'level', price: s2, color: '#3f51b5', label: 'S2' },
    { type: 'level', price: s2 * 0.86, color: '#3f51b5', label: 'S3' },
  ];
}

function applyZonesIfOn() {
  if (zonesOn) chart.setOverlays(demoOverlays());
}

document.getElementById('btn-zones').addEventListener('click', (e) => {
  zonesOn = !zonesOn;
  if (zonesOn) chart.setOverlays(demoOverlays());
  else chart.clearOverlays();
  e.currentTarget.setAttribute('aria-pressed', String(zonesOn));
});

/* Scenario projection — bull ghost path + ±1σ/±2σ vol cone into future space. */
let scenarioOn = false;
function demoScenario() {
  const d = chart.data;
  if (!d || !d.length) return null;
  const H = 48;
  let p = d[d.length - 1].close;
  const path = [];
  for (let i = 1; i <= H; i++) {
    p *= 1 + 0.004 + Math.sin(i / 3.2) * 0.0014;
    path.push(p);
  }
  return { path, cone: true, levels: [1, 2], color: 'up', label: 'bull case' };
}
document.getElementById('btn-scenario').addEventListener('click', (e) => {
  scenarioOn = !scenarioOn;
  if (scenarioOn) {
    const spec = demoScenario();
    if (spec) chart.setScenario(spec);
  } else {
    chart.clearScenario();
  }
  e.currentTarget.setAttribute('aria-pressed', String(scenarioOn));
});

document.getElementById('btn-theme').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  writeHash();
});

chart.addEventListener('wick:select', (e) => {
  console.log('wick:select', e.detail.bar.time, '@', e.detail.price?.toFixed(2));
});

/* ---------------- drawing tools (wickchart-draw plugin layer) ---------------- */

const draw = attachDrawings(chart);

const DRAW_TOOLS = [
  ['btn-draw-select', null],
  ['btn-draw-trend', 'trendline'],
  ['btn-draw-ray', 'ray'],
  ['btn-draw-level', 'hline'],
  ['btn-draw-box', 'rect'],
  ['btn-draw-fib', 'fib'],
  ['btn-draw-text', 'text'],
];
for (const [id, tool] of DRAW_TOOLS) {
  document.getElementById(id).addEventListener('click', () => {
    draw.setTool(tool);
    for (const [id2] of DRAW_TOOLS) {
      document.getElementById(id2).classList.toggle('active', id2 === id);
    }
  });
}
document.getElementById('btn-draw-magnet').addEventListener('click', (e) => {
  const on = !draw.magnet;
  draw.setMagnet(on);
  e.currentTarget.setAttribute('aria-pressed', String(on));
});
document.getElementById('btn-draw-undo').addEventListener('click', () => draw.undo());
document.getElementById('btn-draw-clear').addEventListener('click', () => draw.clear());

// Deleting one drawing was Del/Backspace only, which a touchscreen does not
// have — on a phone you could create drawings and never remove one. The
// button tracks the plugin's selection so it is only live when it would do
// something.
const btnDrawDelete = document.getElementById('btn-draw-delete');
btnDrawDelete.addEventListener('click', () => draw.deleteSelected());
chart.addEventListener('wick:drawselect', (e) => {
  btnDrawDelete.disabled = !e.detail.id;
});
chart.addEventListener('wick:drawings', () => {
  btnDrawDelete.disabled = !draw.selectedId;
});

/* ---------------- plugin toggles: sessions / compare / navigator ---------------- */

const sessions = attachSessions(chart);
const SESSION_MODES = [
  ['off', null],
  ['crypto', 'crypto'],
  ['forex', 'forex'],
  ['NYSE', 'nyse'],
  ['CME', 'cme'],
];
let sessionMode = 0;
const btnSessions = document.getElementById('btn-sessions');
const lblSessions = document.getElementById('lbl-sessions');
btnSessions.addEventListener('click', () => {
  sessionMode = (sessionMode + 1) % SESSION_MODES.length;
  const [label, preset] = SESSION_MODES[sessionMode];
  sessions.setPreset(preset);
  lblSessions.textContent = preset ? 'Sessions · ' + label : 'Sessions';
  btnSessions.setAttribute('aria-pressed', String(!!preset));
  btnSessions.classList.toggle('active', !!preset);
});
// which session is under the crosshair (null = a gap or the weekend)
chart.addEventListener('wick:sessions', (e) => {
  btnSessions.title = e.detail && e.detail.hover
    ? `Session under crosshair: ${e.detail.hover} — click to cycle presets`
    : 'Market session shading (wickchart-sessions plugin) — click to cycle: off → crypto → forex → NYSE → CME';
});

/* ---------------- bar replay (wickchart-replay plugin layer) ---------------- */

const replay = attachReplay(chart);
const btnReplayStart = document.getElementById('btn-replay-start');
const btnReplayPlay = document.getElementById('btn-replay-play');
const btnReplayStep = document.getElementById('btn-replay-step');
const btnReplayStop = document.getElementById('btn-replay-stop');
const lblReplay = document.getElementById('lbl-replay');

btnReplayStart.addEventListener('click', () => {
  stopFeed(); // live updates would fight the replay
  replay.start();
  toast('Replay started — the future is hidden. Space = play/pause, → = step, Esc = exit.');
});
btnReplayPlay.addEventListener('click', () => (replay.playing ? replay.pause() : replay.play()));
btnReplayStep.addEventListener('click', () => replay.step());
btnReplayStop.addEventListener('click', exitReplay);

function exitReplay() {
  if (!replay.active) return;
  replay.stop();
  startFeed();
}

chart.addEventListener('wick:replay', (e) => {
  const d = e.detail;
  document.getElementById('ico-replay-play').style.display = d.playing ? 'none' : '';
  document.getElementById('ico-replay-pause').style.display = d.playing ? '' : 'none';
  btnReplayStep.disabled = !d.active;
  btnReplayStop.disabled = !d.active;
  btnReplayPlay.disabled = !d.active;
  lblReplay.textContent = d.active ? `Replay ${d.index + 1}/${d.total}` : 'Replay';
  btnReplayStart.title = d.active
    ? `Replaying at ${d.speed} bars/s, ${d.remaining} bars hidden — click to re-anchor at 70%`
    : 'Bar replay (wickchart-replay plugin) — start at ~70% of the data; the future stays hidden. Pauses the live feed.';
});

document.addEventListener('keydown', (e) => {
  if (!replay.active) return;
  const el = e.target;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  if (e.key === ' ') {
    e.preventDefault();
    replay.playing ? replay.pause() : replay.play();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    replay.step();
  } else if (e.key === 'Escape') {
    exitReplay();
  }
});

/* ---------------- compare overlays (wickchart-compare plugin layer) ---------------- */

const cmp = attachCompare(chart);
const COMPARE_MODES = ['off', 'ETH', 'ETH+SOL'];
let compareMode = 0;
const compareCache = new Map();
const btnCompare = document.getElementById('btn-compare');
const lblCompare = document.getElementById('lbl-compare');

/** Klines for a compare symbol; falls back to the synthetic history offline. */
async function compareSeries(sym) {
  const key = sym + ':' + state.tf;
  if (compareCache.has(key)) return compareCache.get(key);
  let bars = null;
  if (BINANCE[sym]) {
    try {
      bars = await fetchBinanceKlines(BINANCE[sym], state.tf, CHUNK);
    } catch (_) {
      /* offline — synthetic below */
    }
  }
  if (!bars || !bars.length) bars = getHistory(sym, state.tf).slice(-CHUNK);
  compareCache.set(key, bars);
  return bars;
}

btnCompare.addEventListener('click', async () => {
  compareMode = (compareMode + 1) % COMPARE_MODES.length;
  const mode = COMPARE_MODES[compareMode];
  btnCompare.setAttribute('aria-pressed', String(mode !== 'off'));
  btnCompare.classList.toggle('active', mode !== 'off');
  if (mode === 'off') {
    cmp.clear();
    lblCompare.textContent = 'Compare';
    return;
  }
  lblCompare.textContent = 'Compare · …';
  const list = [];
  for (const s of mode.split('+')) {
    list.push({ label: s, data: await compareSeries(s) });
  }
  cmp.setSeries(list);
  lblCompare.textContent = 'Compare · ' + mode;
});

/* ---------------- range navigator (wickchart-navigator plugin layer) ---------------- */

const btnNavigator = document.getElementById('btn-navigator');
let navPlugin = null;
btnNavigator.addEventListener('click', () => {
  if (navPlugin) {
    navPlugin.detach();
    navPlugin = null;
    btnNavigator.setAttribute('aria-pressed', 'false');
    btnNavigator.classList.remove('active');
  } else {
    if (tapePlugin) btnTape.click(); // the bottom dock fits one strip
    navPlugin = attachNavigator(chart);
    btnNavigator.setAttribute('aria-pressed', 'true');
    btnNavigator.classList.add('active');
  }
});

/* ---------------- pattern signals (wickchart-signals plugin layer) ---------------- */

const signalsPlugin = attachSignals(chart, { kinds: [] }); // starts off — toggle to arm
const btnSignals = document.getElementById('btn-signals');
btnSignals.addEventListener('click', () => {
  const on = !btnSignals.classList.contains('active');
  signalsPlugin.setKinds(on ? ['engulfing', 'pinbar', 'inside'] : []);
  btnSignals.setAttribute('aria-pressed', String(on));
  btnSignals.classList.toggle('active', on);
});
// the pattern under the crosshair (null = none)
chart.addEventListener('wick:signals', (e) => {
  btnSignals.title = e.detail && e.detail.label
    ? `Pattern signals (wickchart-signals plugin) — under crosshair: ${e.detail.label}`
    : 'Pattern signals (wickchart-signals plugin) — bullish/bearish engulfing, pin bars and inside bars as badges; hover one for the explanation';
});

/* ---------------- time & sales (wickchart-tape plugin layer) ---------------- */

const btnTape = document.getElementById('btn-tape');
let tapePlugin = null;
let tapeTimer = 0;
let tapePrice = 0;

function seedTape() {
  const d = chart.data;
  if (!d.length) return;
  tapePrice = d[d.length - 1].close;
  const now = Date.now();
  let p = tapePrice * 0.999;
  const back = [];
  for (let i = 40; i > 0; i--) {
    p += (Math.random() - 0.48) * tapePrice * 0.0004;
    back.push({
      time: now - i * 1500,
      price: +p.toFixed(2),
      size: Math.random() > 0.92 ? Math.round(30 + Math.random() * 90) : +(0.05 + Math.random() * 3).toFixed(2),
    });
  }
  tapePlugin.set(back);
}

// synthetic print stream — random-walks around the live chart's last close
function tapeTick() {
  const d = chart.data;
  if (!d.length) return;
  const drift = (Math.random() - 0.5) * tapePrice * 0.0006;
  tapePrice += drift;
  const k = 1 + Math.floor(Math.random() * 3);
  const now = Date.now();
  let p = tapePrice - drift;
  const prints = [];
  for (let i = 0; i < k; i++) {
    p += drift / k;
    prints.push({
      time: now - (k - i) * 40,
      price: +p.toFixed(2),
      size: Math.random() > 0.9 ? Math.round(25 + Math.random() * 90) : +(0.05 + Math.random() * 3).toFixed(2),
    });
  }
  tapePlugin.push(prints);
}

btnTape.addEventListener('click', () => {
  if (tapePlugin) {
    clearInterval(tapeTimer);
    tapePlugin.detach();
    tapePlugin = null;
    btnTape.setAttribute('aria-pressed', 'false');
    btnTape.classList.remove('active');
    return;
  }
  if (navPlugin) btnNavigator.click(); // the bottom dock fits one strip
  tapePlugin = attachTape(chart, { bigSize: 50 });
  seedTape();
  tapeTimer = setInterval(tapeTick, 450);
  btnTape.setAttribute('aria-pressed', 'true');
  btnTape.classList.add('active');
  toast('Trade tape docked — prints are synthetic here; feed real ones via tape.push().');
});

/* ---------------- persistent alerts (wickchart-alerts-plus plugin) ---------------- */

const alertsPlus = attachAlertsPlus(chart, { key: 'wick-demo-alerts', notify: true, sound: true });
try {
  const restored = JSON.parse(localStorage.getItem('wick-demo-alerts') || '[]').length;
  if (restored) toast(`Restored ${restored} persisted alert${restored > 1 ? 's' : ''} — they survive reloads now.`);
} catch (_) {}
// ask for the notification permission on the first user gesture (policy-friendly)
document.addEventListener('click', () => alertsPlus.requestNotify(), { once: true });

/* ---------------- named layouts (wickchart-layouts plugin) ---------------- */

const layouts = attachLayouts(chart, { drawings: draw, key: 'wick-demo-layouts' });
let layoutIdx = 0;
document.getElementById('btn-layout-save').addEventListener('click', () => {
  const name = prompt('Save the current setup as:', layouts.list()[0]?.name || 'main');
  if (name == null) return;
  layouts.save(name);
  toast(`Layout "${name}" saved — type, indicators, view, drawings, positions & alerts.`);
});
document.getElementById('btn-layout-load').addEventListener('click', () => {
  const names = layouts.list().map((l) => l.name);
  if (!names.length) {
    toast('No saved layouts yet — hit "Save view" first.');
    return;
  }
  const name = names[layoutIdx % names.length];
  layoutIdx++;
  layouts.load(name);
  toast(`Loaded layout "${name}".`);
});

/* ---------------- trade demo: positions & alerts ---------------- */

let demoPosCount = 0;
let demoAlertCount = 0;

document.getElementById('btn-long').addEventListener('click', () => {
  const d = chart.data;
  if (!d.length) return;
  const entry = d[d.length - 1].close;
  demoPosCount += 1;
  chart.addPosition({
    id: 'demo-' + demoPosCount,
    side: 'long',
    entry,
    stop: entry * 0.98,
    target: entry * 1.04,
    qty: 0.5,
  });
});

document.getElementById('btn-alert').addEventListener('click', () => {
  const d = chart.data;
  if (!d.length) return;
  const price = d[d.length - 1].close * 1.01;
  demoAlertCount += 1;
  const id = chart.addAlert({ id: 'demo-' + demoAlertCount, price, direction: 'above' });
  alertsPlus.sync(); // demo alerts persist across reloads (wickchart-alerts-plus)
  toast(`Alert set at ${price.toFixed(2)} — fires when price crosses above.`);
  void id;
});

document.getElementById('btn-expr-alert').addEventListener('click', () => {
  const when = 'volume > sma(volume,20) * 2.5';
  demoAlertCount += 1;
  const id = chart.addAlert({ id: 'expr-' + demoAlertCount, when, once: false });
  toast(
    id
      ? `Scripted alert armed: ${when} — fires on the next volume spike.`
      : 'Scripted alert rejected — invalid predicate.'
  );
});

document.getElementById('btn-clear-trade').addEventListener('click', () => {
  chart.clearPositions();
  chart.clearAlerts();
});

/* Risk plan demo — R-multiple grid: entry at the last close, stop 1R below
 * (the lower of −1.8% and the recent 20-bar low), dashed 1R/2R/3R rewards. */
let riskOn = false;
document.getElementById('btn-risk').addEventListener('click', (e) => {
  riskOn = !riskOn;
  if (riskOn) {
    const d = chart.data;
    if (d.length) {
      const entry = d[d.length - 1].close;
      const recent = d.slice(-20).map((b) => b.low);
      const stop = Math.min(entry * 0.982, Math.min(...recent));
      chart.setRiskPlan({ entry, stop, multiples: [1, 2, 3], label: 'demo plan' });
      toast(`Risk plan set — 1R = ${(entry - stop).toFixed(2)} · targets +1R/+2R/+3R`);
    }
  } else {
    chart.clearRiskPlan();
  }
  e.currentTarget.setAttribute('aria-pressed', String(riskOn));
});

chart.addEventListener('wick:alert', (e) => {
  if (e.detail.when) {
    toast(`Expr alert ${e.detail.id} fired — close ${e.detail.price.toFixed(2)} · ${e.detail.when}`);
  } else {
    toast(`Alert ${e.detail.id}: price crossed ${e.detail.price.toFixed(2)}`);
  }
});

/* ---------------- boot ---------------- */

loadSymbol();
