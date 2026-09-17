/* ==========================================================================
 * <wick-feed> — declarative data feeds for <wick-chart>.
 *
 *   <script type="module" src="https://unpkg.com/wickchart/feed"></script>
 *
 *   <wick-feed for="chart" binance="BTCUSDT" tf="1h"></wick-feed>
 *   <wick-chart id="chart" indicators="sma:20 volume"></wick-chart>
 *
 * A fully live chart with zero JavaScript written. Sources:
 *   binance="SYMBOL"  live via WebSocket (REST klines + backfill; falls back
 *                     to REST polling, then to a synthetic stream when the
 *                     network/region blocks Binance)
 *   demo="KEY"        deterministic offline synthetic feed (BTC/ETH/SOL/DEMO
 *                     base prices; any other key seeds a fresh series)
 *   url="ENDPOINT"    generic REST JSON array of bars; optional poll="SECONDS"
 *
 * Attributes: for (chart id; auto-pairs with the first chart otherwise),
 *   tf (1m…1w), limit (initial bars, default 500), live="false" to disable
 *   streaming. Status is reflected in the `status` attribute and via
 *   `wick-feed:status` events (loading / live / polling / fallback / loaded /
 *   waiting / idle). `wick-feed:fallback` fires when a live source degrades.
 * ========================================================================== */

import './wick-chart.js';
import {
  genSynthetic,
  makeSynthStream,
  fetchBinanceKlines,
  openBinanceSocket,
  tfToSeconds,
  BASE_PRICES,
  parseAggregate,
  aggregateTrades,
  genSyntheticTrades,
  makeSynthTradeStream,
  synthTradesPerBar,
  fetchBinanceAggTrades,
  fetchBinanceAggTradesSince,
  openBinanceTradeSocket,
  normalizeTrades,
} from './feeds.js';


const LIVE_TICK_MS = 650;

const HTMLElementBase = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

class WickFeed extends HTMLElementBase {
  static get observedAttributes() {
    return ['for', 'binance', 'demo', 'url', 'tf', 'limit', 'poll', 'live', 'aggregate'];
  }

  constructor() {
    super();
    this._gen = 0; // generation token: stale async callbacks no-op
    this._closers = [];
    this._timer = 0;
    this._observer = null;
  }

  connectedCallback() {
    this._scheduleRestart();
  }

  disconnectedCallback() {
    this._teardown();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal !== newVal) this._scheduleRestart();
  }

  _scheduleRestart() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = 0;
      if (this.isConnected) this._restart();
    }, 0);
  }

  _teardown() {
    this._gen++;
    clearTimeout(this._timer);
    this._timer = 0;
    for (const close of this._closers.splice(0)) {
      try {
        close();
      } catch (_) {}
    }
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
  }

  _setStatus(status, detail) {
    if (!this.isConnected) return;
    this.setAttribute('status', status);
    this._fire('status', { status, ...detail });
  }

  /** Dispatch `wick-feed:name`. */
  _fire(name, detail) {
    this.dispatchEvent(new CustomEvent('wick-feed:' + name, { detail }));
  }
  /** Resolve the target chart (by `for` id, else the first chart element —
   *  <wick-chart>). */
  _resolveChart() {
    const id = this.getAttribute('for');
    if (id) {
      const el = document.getElementById(id);
      return el && (el.tagName === 'WICK-CHART' || el.tagName === 'HAB-CHART') ? el : null;
    }
    return document.querySelector('wick-chart');
  }

  _restart() {
    this._teardown();
    let chart = this._resolveChart();
    if (!chart || typeof chart.setData !== 'function') {
      // chart not in the DOM yet (or not upgraded) — watch for it
      this._setStatus('waiting');
      customElements.whenDefined('wick-chart').then(() => {
        if (!this.isConnected) return;
        this._observer = this._observer || new MutationObserver(() => {
          const c = this._resolveChart();
          if (c && typeof c.setData === 'function') {
            this._observer.disconnect();
            this._observer = null;
            this._scheduleRestart();
          }
        });
        this._observer.observe(document.documentElement, { childList: true, subtree: true });
      });
      return;
    }
    // aggregate="tick:200|volume:50|dollar:25000" switches the feed from
    // time bars to information-based bars built client-side from raw trades
    const agg = parseAggregate(this.getAttribute('aggregate'));
    if (this.hasAttribute('aggregate') && !agg) {
      this._setStatus('error', { message: 'aggregate must be tick|volume|dollar[:N]' });
      return;
    }
    if (!chart.hasAttribute('label')) {
      const sym = this.getAttribute('binance') || this.getAttribute('demo');
      if (sym) {
        const sub = agg ? `${agg.kind}:${String(+(+agg.threshold).toFixed(6))} bars` : (this.getAttribute('tf') || '1h');
        chart.setAttribute('label', `${String(sym).toUpperCase()} · ${sub}`);
      }
    }

    const gen = this._gen;
    const live = this.getAttribute('live') !== 'false';
    const tfId = (this.getAttribute('tf') || '1h').toLowerCase();
    const limit = Math.max(10, Math.min(5000, parseInt(this.getAttribute('limit') || '500', 10) || 500));
    const sym = this.getAttribute('binance');
    const url = this.getAttribute('url');
    const demo = this.getAttribute('demo');

    if (agg) {
      if (sym) this._binanceTrades(gen, chart, String(sym).toUpperCase(), agg, limit, live);
      else if (url) this._restTrades(gen, chart, url, agg, limit, live);
      else if (demo != null) {
        this._syntheticTrades(gen, chart, demo === '' ? 'DEMO' : demo, agg, limit, live);
      } else this._setStatus('idle');
      return;
    }
    if (sym) this._binance(gen, chart, String(sym).toUpperCase(), tfId, limit, live);
    else if (url) this._rest(gen, chart, url, limit, live);
    else if (demo != null) {
      this._synthetic(gen, chart, demo === '' ? 'DEMO' : demo, tfId, limit, live);
    } else this._setStatus('idle');
  }

  /* ---------------- synthetic source ---------------- */

  _synthetic(gen, chart, key, tfId, limit, live, status = 'live') {
    const sec = tfToSeconds(tfId);
    const base = BASE_PRICES[key.toUpperCase()] || 100;
    const histLen = Math.max(limit * 5, 3000);
    const hist = genSynthetic(`${key}:${tfId}`, sec, histLen, base);
    chart.onloadmore = (fromTime) => hist.filter((b) => b.time < fromTime).slice(-limit);
    chart.setData(hist.slice(-limit));
    this._setStatus(status);
    if (!live) return;
    const d = chart.data;
    const next = makeSynthStream(sec, d.length ? d[d.length - 1].close : base);
    const timer = setInterval(() => {
      if (this._gen !== gen || !this.isConnected) return;
      chart.update(next());
    }, LIVE_TICK_MS);
    this._closers.push(() => clearInterval(timer));
  }

  /* ---------------- Binance source ---------------- */

  async _binance(gen, chart, sym, tfId, limit, live) {
    this._setStatus('loading');
    try {
      const bars = await fetchBinanceKlines(sym, tfId, limit);
      if (this._gen !== gen || !this.isConnected) return;
      chart.setData(bars);
      chart.onloadmore = (fromTime) => fetchBinanceKlines(sym, tfId, limit, fromTime);
      if (!live) {
        this._setStatus('loaded');
        return;
      }
      const ws = openBinanceSocket(
        sym,
        tfId,
        (bar) => {
          if (this._gen !== gen || !this.isConnected) return;
          this._setStatus('live');
          chart.update(bar);
        },
        () => {
          if (this._gen !== gen || !this.isConnected) return;
          this._pollBinance(gen, chart, sym, tfId);
        }
      );
      this._closers.push(() => ws.close());
    } catch (err) {
      if (this._gen !== gen || !this.isConnected) return;
      this._degrade(gen, chart, sym, tfId, limit, live, err);
    }
  }

  _pollBinance(gen, chart, sym, tfId) {
    this._setStatus('polling');
    const timer = setInterval(async () => {
      if (this._gen !== gen || !this.isConnected) return;
      try {
        const bars = await fetchBinanceKlines(sym, tfId, 2);
        for (const b of bars) chart.update(b);
      } catch (_) {
        clearInterval(timer);
        this._degrade(gen, chart, sym, tfId, 500, true, new Error('poll failed'));
      }
    }, 10000);
    this._closers.push(() => clearInterval(timer));
  }

  _degrade(gen, chart, sym, tfId, limit, live, err) {
    this._fire('fallback', { reason: err && err.message });
    this._synthetic(gen, chart, sym, tfId, limit, live, 'fallback');
  }

  /* ---------------- aggregate sources (information-based bars) ------------- */

  /**
   * Wrap chart.update for aggregated bars: the chart keys bars by timestamp,
   * and two groups can close inside the same millisecond, so emitted times
   * are nudged +1ms to stay strictly increasing (keeps the one-bar-per-
   * timestamp integrity invariant; display-only, values are untouched).
   */
  _aggEmit(gen, chart) {
    let last = -Infinity;
    return (bar) => {
      if (!bar || this._gen !== gen || !this.isConnected) return;
      if (bar.time <= last) bar = { ...bar, time: last + 1 };
      last = bar.time;
      chart.update(bar);
    };
  }

  /** Seed + stream one aggregator onto the chart (shared by all sources). */
  _aggAttach(gen, chart, res, bars, limit, status) {
    chart.setData([...bars.slice(-limit), ...(res.pending ? [res.pending] : [])].slice(-limit));
    this._setStatus(status);
    return {
      emit: this._aggEmit(gen, chart),
      aggregator: res.aggregator,
      /** Push one print through; emits the closed bar, then the forming one. */
      push(t) {
        const closed = res.aggregator.add(t);
        if (closed) this.emit(closed);
        this.emit(res.aggregator.current());
      },
    };
  }

  _syntheticTrades(gen, chart, key, agg, limit, live, status = 'live') {
    const base = BASE_PRICES[key.toUpperCase()] || 100;
    const perBar = synthTradesPerBar(agg, base);
    const seed = Math.max(2000, Math.min(48000, Math.ceil(limit * perBar) * 2));
    const full = aggregateTrades(genSyntheticTrades(`${key}:agg`, seed, base), agg.kind, agg.threshold);
    const bars = full.bars;
    chart.onloadmore = (fromTime) => bars.filter((b) => b.time < fromTime).slice(-limit);
    const handle = this._aggAttach(gen, chart, full, bars, limit, status);
    if (!live) return;
    const lastPrice = (full.pending || bars[bars.length - 1] || { close: base }).close;
    const next = makeSynthTradeStream(lastPrice);
    const timer = setInterval(() => {
      if (this._gen !== gen || !this.isConnected) return;
      const n = 2 + ((Math.random() * 6) | 0); // a burst of prints per tick
      for (let i = 0; i < n; i++) handle.push(next());
    }, LIVE_TICK_MS);
    this._closers.push(() => clearInterval(timer));
  }

  async _binanceTrades(gen, chart, sym, agg, limit, live) {
    this._setStatus('loading');
    try {
      // prints-per-bar is instrument-specific — size the seed from a first page
      const first = await fetchBinanceAggTrades(sym, 1000, 1);
      let perBar = agg.kind === 'tick' ? agg.threshold : 40;
      if (agg.kind !== 'tick' && first.trades.length) {
        let vol = 0;
        let notl = 0;
        for (const t of first.trades) {
          vol += t.size;
          notl += t.price * t.size;
        }
        const n = first.trades.length;
        perBar = agg.kind === 'volume'
          ? agg.threshold / Math.max(1e-12, vol / n)
          : agg.threshold / Math.max(1e-12, notl / n);
      }
      let trades = first.trades;
      let oldestId = first.oldestId;
      const target = Math.max(1000, Math.min(25000, Math.ceil(limit * perBar)));
      if (trades.length < target) {
        const older = await fetchBinanceAggTrades(sym, target - trades.length, 25, oldestId);
        trades = older.trades.concat(trades);
        if (older.oldestId != null) oldestId = older.oldestId;
      }
      if (this._gen !== gen || !this.isConnected) return;
      const res = aggregateTrades(trades, agg.kind, agg.threshold);
      const handle = this._aggAttach(gen, chart, res, res.bars, limit, 'loaded');
      let lastId = trades.length ? trades[trades.length - 1].id : 0;
      chart.onloadmore = async (fromTime) => {
        const older = await fetchBinanceAggTrades(sym, Math.ceil(limit * perBar), 10, oldestId);
        if (older.oldestId != null) oldestId = older.oldestId;
        return aggregateTrades(older.trades, agg.kind, agg.threshold).bars
          .filter((b) => b.time < fromTime)
          .slice(-limit);
      };
      if (!live) return;
      const ws = openBinanceTradeSocket(
        sym,
        (t) => {
          if (this._gen !== gen || !this.isConnected) return;
          if (!(t.id > lastId)) return; // seed/WS overlap
          lastId = t.id;
          handle.push(t);
          this._setStatus('live');
        },
        () => {
          if (this._gen !== gen || !this.isConnected) return;
          this._pollBinanceTrades(gen, chart, sym, handle, lastId, agg, limit, live);
        }
      );
      this._closers.push(() => ws.close());
    } catch (err) {
      if (this._gen !== gen || !this.isConnected) return;
      this._fire('fallback', { reason: err && err.message });
      this._syntheticTrades(gen, chart, sym, agg, limit, live, 'fallback');
    }
  }

  _pollBinanceTrades(gen, chart, sym, handle, fromId, agg, limit, live) {
    this._setStatus('polling');
    let lastId = fromId;
    const timer = setInterval(async () => {
      if (this._gen !== gen || !this.isConnected) return;
      try {
        const { trades, latestId } = await fetchBinanceAggTradesSince(sym, lastId + 1);
        for (const t of trades) {
          if (!(t.id > lastId)) continue;
          lastId = t.id;
          handle.push(t);
        }
        if (latestId > lastId) lastId = latestId;
      } catch (_) {
        clearInterval(timer);
        this._fire('fallback', { reason: 'trade poll failed' });
        this._syntheticTrades(gen, chart, sym, agg, limit, live, 'fallback');
      }
    }, 10000);
    this._closers.push(() => clearInterval(timer));
  }

  async _restTrades(gen, chart, url, agg, limit, live) {
    this._setStatus('loading');
    const pull = async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return normalizeTrades(Array.isArray(body) ? body : body.trades || body.bars);
    };
    try {
      const trades = await pull();
      if (this._gen !== gen || !this.isConnected) return;
      const res = aggregateTrades(trades, agg.kind, agg.threshold);
      this._aggAttach(gen, chart, res, res.bars, limit, 'loaded');
      if (!live) return;
      const pollSec = Math.max(1, parseInt(this.getAttribute('poll') || '0', 10) || 0);
      if (!pollSec) return;
      // dedupe by print time: a same-ms reprint would double-count notional
      let lastTime = trades.length ? trades[trades.length - 1].time : 0;
      const emit = this._aggEmit(gen, chart);
      const timer = setInterval(async () => {
        if (this._gen !== gen || !this.isConnected) return;
        try {
          for (const t of await pull()) {
            if (t.time <= lastTime) continue;
            lastTime = t.time;
            const closed = res.aggregator.add(t);
            if (closed) emit(closed);
          }
          emit(res.aggregator.current());
          this._setStatus('polling');
        } catch (_) {}
      }, pollSec * 1000);
      this._closers.push(() => clearInterval(timer));
    } catch (err) {
      if (this._gen !== gen || !this.isConnected) return;
      this._setStatus('error', { message: err && err.message });
    }
  }

  /* ---------------- generic REST source ---------------- */

  async _rest(gen, chart, url, limit, live) {
    this._setStatus('loading');
    const pull = async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return Array.isArray(body) ? body : body.bars;
    };
    try {
      const bars = await pull();
      if (this._gen !== gen || !this.isConnected) return;
      chart.setData(bars.slice(-limit));
      this._setStatus(live ? 'loaded' : 'loaded');
      if (!live) return;
      const pollSec = Math.max(1, parseInt(this.getAttribute('poll') || '0', 10) || 0);
      if (!pollSec) return;
      const timer = setInterval(async () => {
        if (this._gen !== gen || !this.isConnected) return;
        try {
          const fresh = await pull();
          for (const b of fresh.slice(-3)) chart.update(b);
          this._setStatus('polling');
        } catch (_) {}
      }, pollSec * 1000);
      this._closers.push(() => clearInterval(timer));
    } catch (err) {
      if (this._gen !== gen || !this.isConnected) return;
      this._setStatus('error', { message: err && err.message });
    }
  }
}

if (typeof customElements !== 'undefined') {
  if (!customElements.get('wick-feed')) {
    customElements.define('wick-feed', WickFeed);
  }
}

export default WickFeed;
export { WickFeed };
// pure aggregation helpers — exported so apps can pipe their own trade
// streams through the same machinery `aggregate=` uses
export {
  parseAggregate,
  TickBarAggregator,
  aggregateTrades,
  normalizeTrades,
  genSyntheticTrades,
  makeSynthTradeStream,
} from './feeds.js';
