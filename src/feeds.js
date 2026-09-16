/* ==========================================================================
 * WickChart feeds — data-source helpers shared by <wick-feed> and the demo app.
 * Browser module (uses fetch/WebSocket inside functions); importable in Node
 * for unit-testing the pure generators.
 * MIT License.
 * ========================================================================== */

export const TF_SECONDS = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200,
  '1d': 86400, '3d': 259200, '1w': 604800,
};

/** Seconds for a timeframe id ('15m', '1h', '1D'…); defaults to 1h. */
export function tfToSeconds(tf) {
  return TF_SECONDS[String(tf).toLowerCase()] || 3600;
}

export const BASE_PRICES = { BTC: 64250, ETH: 3120, SOL: 148, DEMO: 100 };

/* ---------------- deterministic synthetic data ---------------- */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rnd) {
  let u = 0;
  let v = 0;
  while (!u) u = rnd();
  while (!v) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function hashStr(s) {
  let h = 2166136261;
  for (const c of String(s)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic synthetic OHLCV history (random walk with volatility regimes
 * and mild mean reversion). Same key → same series.
 * @param {string} key seed key (symbol, symbol+tf, …)
 * @param {number} sec timeframe in seconds
 * @param {number} n bar count
 * @param {number} [base=100] starting/base price
 */
export function genSynthetic(key, sec, n, base = 100) {
  const rnd = mulberry32(hashStr(key) ^ 0x9e3779b9);
  const tfMs = sec * 1000;
  const t0 = Math.floor(Date.now() / tfMs) * tfMs - (n - 1) * tfMs;
  let price = base;
  let drift = 0.0002;
  let vol = 0.011;
  let regimeLeft = 0;
  const bars = [];
  for (let i = 0; i < n; i++) {
    if (regimeLeft <= 0) {
      regimeLeft = (40 + rnd() * 140) | 0;
      drift = (rnd() - 0.48) * 0.0016;
      vol = 0.005 + rnd() * 0.02;
    }
    regimeLeft--;
    const open = price;
    const revert = -0.004 * Math.log(price / base);
    const ret = drift + revert + vol * gauss(rnd);
    const close = open * Math.exp(ret);
    const high = Math.max(open, close) * (1 + Math.abs(gauss(rnd)) * vol * 0.6);
    const low = Math.min(open, close) * (1 - Math.abs(gauss(rnd)) * vol * 0.6);
    const volume = Math.max(1, Math.round(420 * (1 + (Math.abs(ret) / vol) * 2 + rnd() * 0.6)));
    bars.push({ time: t0 + i * tfMs, open, high, low, close, volume });
    price = close;
  }
  return bars;
}

/**
 * Stateful synthetic live stream: mutates the current bar each tick and
 * rolls over on timeframe boundaries. Bridges from `startPrice` when given.
 * @param {number} sec timeframe in seconds
 * @param {number} [startPrice] bridge continuity from the last known price
 */
export function makeSynthStream(sec, startPrice) {
  const tfMs = sec * 1000;
  const rnd = mulberry32((Math.random() * 1e9) >>> 0);
  let cur = null;
  return () => {
    const t = Math.floor(Date.now() / tfMs) * tfMs;
    if (!cur || cur.time !== t) {
      const open = cur ? cur.close : (startPrice || 100) * (1 + gauss(rnd) * 0.002);
      cur = { time: t, open, high: open, low: open, close: open, volume: 0 };
    } else {
      const vol = 0.004;
      cur.close = Math.max(1e-8, cur.close * Math.exp(vol * gauss(rnd) * 0.35));
      cur.high = Math.max(cur.high, cur.close);
      cur.low = Math.min(cur.low, cur.close);
      cur.volume += Math.round(20 + rnd() * 60);
    }
    return { ...cur };
  };
}

/* ---------------- information-based bar aggregation ---------------- */
//
// Tick / volume / dollar bars ("advanced bars"): a bar closes when a threshold
// of *information* is reached — N prints, N base units, or $N notional — not
// when the clock says so. Same discipline as the rest of this file: plain
// data in, plain data out; the aggregator itself has no DOM and no network.

/** Default thresholds per kind. They are per-instrument — there is no
 *  universal "one bar" size, treat these as starting points to tune. */
export const AGG_DEFAULTS = { tick: 100, volume: 10, dollar: 25000 };

/**
 * Parse an `aggregate` spec — `tick`, `volume:50`, `dollar:25000` (case and
 * whitespace tolerant; the value is the bar size in trades / base units /
 * quote units respectively).
 * @param {string} spec attribute value
 * @returns {{kind: 'tick'|'volume'|'dollar', threshold: number}|null} null when invalid
 */
export function parseAggregate(spec) {
  if (spec == null || spec === false) return null;
  const m = /^\s*(tick|volume|dollar)(?:\s*:\s*([0-9]*\.?[0-9]+))?\s*$/i.exec(String(spec));
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const threshold = m[2] != null ? Number(m[2]) : AGG_DEFAULTS[kind];
  if (!Number.isFinite(threshold) || threshold <= 0) return null;
  return { kind, threshold };
}

/**
 * Streaming aggregator: feed it trades, get bars back. `add()` returns a
 * bar the moment the threshold is crossed ({@link current} keeps exposing
 * the forming bar meanwhile). The completing trade belongs entirely to the
 * closing bar — a whale print is never split across two bars.
 */
export class TickBarAggregator {
  /**
   * @param {'tick'|'volume'|'dollar'} kind what the threshold counts
   * @param {number} threshold bar size (trades / base units / quote units)
   */
  constructor(kind = 'tick', threshold = AGG_DEFAULTS.tick) {
    this.kind = kind === 'volume' || kind === 'dollar' ? kind : 'tick';
    this.threshold = Number.isFinite(+threshold) && +threshold > 0 ? +threshold : AGG_DEFAULTS[this.kind];
    this._bar = null;
  }

  /**
   * Feed one trade `{ time, price, size }` (seconds auto-upgraded to ms,
   * same heuristic as the chart). Returns the completed bar —
   * `{ time, open, high, low, close, volume, closed: true }` — when the
   * threshold is reached, else null.
   * @returns {object|null}
   */
  add(trade) {
    const price = Number(trade && trade.price);
    const size = Number(trade && trade.size);
    let time = Number(trade && trade.time);
    if (!(price > 0) || !Number.isFinite(price)) return null;
    const qty = Number.isFinite(size) && size > 0 ? size : 0;
    if (!Number.isFinite(time)) time = Date.now();
    if (time < 1e11) time *= 1000;
    if (!this._bar) {
      this._bar = {
        time: Math.round(time), open: price, high: price, low: price, close: price,
        volume: 0, n: 0, notional: 0,
      };
    }
    const b = this._bar;
    if (price > b.high) b.high = price;
    if (price < b.low) b.low = price;
    b.close = price;
    b.volume += qty;
    b.n++;
    b.notional += price * qty;
    const filled = this.kind === 'tick' ? b.n : this.kind === 'volume' ? b.volume : b.notional;
    if (filled >= this.threshold) {
      this._bar = null;
      return {
        time: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
        volume: +b.volume.toFixed(8), closed: true,
      };
    }
    return null;
  }

  /** The forming bar as plain chart-bar fields (no internals), or null. */
  current() {
    if (!this._bar) return null;
    const { time, open, high, low, close } = this._bar;
    return { time, open, high, low, close, volume: +this._bar.volume.toFixed(8) };
  }

  /** Close the forming bar as-is (end of tape / teardown), or null. */
  flush() {
    const c = this.current();
    this._bar = null;
    return c ? { ...c, closed: true } : null;
  }
}

/**
 * One-pass batch aggregation of a trade history. Returns the closed bars,
 * the still-forming remainder, and the live aggregator positioned at the end
 * of the tape so streaming can continue without a seam.
 * @param {Array<object>} trades `{ time, price, size }` prints
 * @param {'tick'|'volume'|'dollar'} kind
 * @param {number} threshold
 */
export function aggregateTrades(trades, kind, threshold) {
  const aggregator = new TickBarAggregator(kind, threshold);
  const bars = [];
  for (const t of Array.isArray(trades) ? trades : []) {
    const closed = aggregator.add(t);
    if (closed) bars.push(closed);
  }
  return { bars, pending: aggregator.current(), aggregator };
}

/**
 * Coerce a generic JSON trades array into plain `{ time, price, size }`
 * (ms, seconds auto-upgraded; `size` also read from `qty`/`amount`).
 * Invalid entries are dropped, never thrown — same contract as the chart's
 * other normalizers. Output is sorted by time.
 */
export function normalizeTrades(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const price = Number(r.price);
    const size = Number(r.size != null ? r.size : r.qty != null ? r.qty : r.amount);
    let time = Number(r.time != null ? r.time : r.t);
    if (!(price > 0) || !(size > 0) || !Number.isFinite(time)) continue;
    if (time < 1e11) time *= 1000;
    out.push({ time: Math.round(time), price, size });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/* ------------- synthetic trade prints (offline aggregate demos) ------------- */

// Synthetic prints model human-sized notionals: $20 + U³·$8000, mean ≈ $2,020
// regardless of instrument — sizes are notional / price, so the tape adapts
// to a $100 demo stock and a $64k BTC the same way.
const SYNTH_NOTIONAL_MIN = 20;
const SYNTH_NOTIONAL_SPAN = 8000;
const SYNTH_NOTIONAL_MEAN = SYNTH_NOTIONAL_MIN + SYNTH_NOTIONAL_SPAN / 4;

/**
 * Deterministic synthetic trade prints (random-walk price with volatility
 * regimes, heavy-tailed sizes). Same key → same tape.
 * @param {string} key seed key
 * @param {number} [n=24000] print count
 * @param {number} [base=100] starting price
 */
export function genSyntheticTrades(key, n = 24000, base = 100) {
  const rnd = mulberry32(hashStr('trades:' + key) ^ 0x2545f491);
  const dt = 250; // ms between prints
  const t0 = Math.floor(Date.now() / dt) * dt - (n - 1) * dt;
  let price = base;
  let vol = 0.0006;
  let regimeLeft = 0;
  const trades = [];
  for (let i = 0; i < n; i++) {
    if (regimeLeft-- <= 0) {
      regimeLeft = 200 + ((rnd() * 1200) | 0);
      vol = 0.0002 + rnd() * 0.0014;
    }
    price = Math.max(1e-8, price * Math.exp(vol * gauss(rnd)));
    const notional = SYNTH_NOTIONAL_MIN + Math.pow(rnd(), 3) * SYNTH_NOTIONAL_SPAN;
    trades.push({
      time: t0 + i * dt,
      price: +price.toFixed(8),
      size: +Math.max(1e-8, notional / price).toFixed(8),
    });
  }
  return trades;
}

/**
 * Stateful synthetic live tape: one print per call, bridging from
 * `startPrice` (e.g. the last price of a seeded history).
 * @param {number} [startPrice=100]
 */
export function makeSynthTradeStream(startPrice = 100) {
  const rnd = mulberry32((Math.random() * 1e9) >>> 0);
  let price = startPrice;
  let vol = 0.0006;
  let regimeLeft = 0;
  let t = Date.now();
  return () => {
    if (regimeLeft-- <= 0) {
      regimeLeft = 50 + ((rnd() * 350) | 0);
      vol = 0.0002 + rnd() * 0.0014;
    }
    t += 60 + ((rnd() * 420) | 0);
    price = Math.max(1e-8, price * Math.exp(vol * gauss(rnd)));
    const notional = SYNTH_NOTIONAL_MIN + Math.pow(rnd(), 3) * SYNTH_NOTIONAL_SPAN;
    return {
      time: t,
      price: +price.toFixed(8),
      size: +Math.max(1e-8, notional / price).toFixed(8),
    };
  };
}

/**
 * Expected synthetic prints per bar — used to size the offline seed so a
 * demo chart starts with roughly the requested bar count.
 * @param {{kind: string, threshold: number}} agg
 * @param {number} [base=100]
 */
export function synthTradesPerBar(agg, base = 100) {
  if (agg.kind === 'tick') return agg.threshold;
  const meanSize = SYNTH_NOTIONAL_MEAN / Math.max(1e-8, base);
  const per = agg.kind === 'volume' ? agg.threshold / meanSize : agg.threshold / SYNTH_NOTIONAL_MEAN;
  return Math.max(1, per);
}

/* ---------------- Binance public API ---------------- */

/**
 * Fetch klines from Binance's public REST API.
 * @param {string} symbol e.g. 'BTCUSDT'
 * @param {string} tfId interval id ('15m','1h','1d'…)
 * @param {number} [limit=500]
 * @param {number} [endTime] fetch bars older than this (ms) — for backfill
 */
export async function fetchBinanceKlines(symbol, tfId, limit = 500, endTime) {
  let url =
    `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(tfId)}&limit=${limit}`;
  if (endTime) url += `&endTime=${endTime - 1}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const rows = await res.json();
  return rows.map((k) => ({
    time: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
  }));
}

/**
 * Open a Binance kline WebSocket. `onDown(err)` fires on error/close/timeout
 * (after which the socket is dead and the caller should fall back).
 * @returns {{close(): void}}
 */
export function openBinanceSocket(symbol, tfId, onBar, onDown, timeoutMs = 8000) {
  let ws;
  try {
    ws = new WebSocket(
      `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${tfId}`
    );
  } catch (err) {
    onDown(err);
    return { close() {} };
  }
  let dead = false;
  const failTimer = setTimeout(() => {
    if (!dead && ws.readyState !== WebSocket.OPEN) {
      dead = true;
      try {
        ws.close();
      } catch (_) {}
      onDown(new Error('timeout'));
    }
  }, timeoutMs);
  ws.onopen = () => clearTimeout(failTimer);
  ws.onmessage = (ev) => {
    try {
      const k = JSON.parse(ev.data).k;
      if (!k) return;
      // k.x is Binance's "this kline is final" flag — pass it through so
      // close-mode alerts can fire the moment the candle closes rather than
      // waiting for the next one to arrive.
      onBar({
        time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v,
        closed: k.x === true,
      });
    } catch (_) {}
  };
  ws.onclose = () => {
    if (dead) return;
    dead = true;
    clearTimeout(failTimer);
    onDown(new Error('closed'));
  };
  ws.onerror = () => {};
  return {
    close() {
      dead = true;
      ws.onclose = null;
      ws.onerror = null;
      clearTimeout(failTimer);
      try {
        ws.close();
      } catch (_) {}
    },
  };
}

/**
 * Fetch Binance aggTrades, paging backwards from the newest prints (or from
 * below `beforeId`) until `minTrades` prints / `maxPages` requests / the
 * start of the symbol's history. Returns `{ trades, oldestId }` ascending by
 * time; each print carries its Binance id so live streams can resume without
 * overlaps.
 * @param {string} symbol e.g. 'BTCUSDT'
 * @param {number} [minTrades=1000] stop once at least this many prints are held
 * @param {number} [maxPages=25] hard request cap (1000 prints per page)
 * @param {number} [beforeId] only fetch prints with an id lower than this
 */
export async function fetchBinanceAggTrades(symbol, minTrades = 1000, maxPages = 25, beforeId) {
  const out = [];
  let oldest = beforeId != null && Number.isFinite(+beforeId) ? +beforeId : null;
  for (let page = 0; page < maxPages && out.length < minTrades; page++) {
    let url =
      `https://api.binance.com/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=1000`;
    if (oldest != null) url += `&fromId=${Math.max(0, oldest - 1000)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) {
      if (beforeId != null && r.a >= beforeId) continue; // window overlap guard
      out.push({ id: r.a, time: r.T, price: +r.p, size: +r.q });
    }
    oldest = rows[0].a;
    if (rows.length < 1000) break; // reached the beginning of the tape
  }
  out.sort((a, b) => a.time - b.time || a.id - b.id);
  return { trades: out, oldestId: oldest };
}

/**
 * One forward window of aggTrades starting at `fromId` — the catch-up call
 * for REST polling after a trade socket drops. Returns `{ trades, latestId }`.
 * @param {string} symbol
 * @param {number} fromId first print id to fetch (use lastSeenId + 1)
 */
export async function fetchBinanceAggTradesSince(symbol, fromId) {
  const url =
    `https://api.binance.com/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}` +
    `&fromId=${Math.max(0, Number(fromId) || 0)}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const rows = await res.json();
  const trades = (Array.isArray(rows) ? rows : []).map((r) => ({
    id: r.a, time: r.T, price: +r.p, size: +r.q,
  }));
  return { trades, latestId: trades.length ? trades[trades.length - 1].id : Number(fromId) || 0 };
}

/**
 * Open a Binance aggTrade WebSocket — raw prints for information-based bar
 * aggregation. Same lifecycle contract as openBinanceSocket: `onDown(err)`
 * fires on error/close/timeout, after which the socket is dead and the
 * caller should fall back.
 * @returns {{close(): void}}
 */
export function openBinanceTradeSocket(symbol, onTrade, onDown, timeoutMs = 8000) {
  let ws;
  try {
    ws = new WebSocket(
      `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@aggTrade`
    );
  } catch (err) {
    onDown(err);
    return { close() {} };
  }
  let dead = false;
  const failTimer = setTimeout(() => {
    if (!dead && ws.readyState !== WebSocket.OPEN) {
      dead = true;
      try {
        ws.close();
      } catch (_) {}
      onDown(new Error('timeout'));
    }
  }, timeoutMs);
  ws.onopen = () => clearTimeout(failTimer);
  ws.onmessage = (ev) => {
    try {
      const t = JSON.parse(ev.data);
      if (!t || t.e !== 'aggTrade') return;
      onTrade({ id: t.a, time: t.T, price: +t.p, size: +t.q });
    } catch (_) {}
  };
  ws.onclose = () => {
    if (dead) return;
    dead = true;
    clearTimeout(failTimer);
    onDown(new Error('closed'));
  };
  ws.onerror = () => {};
  return {
    close() {
      dead = true;
      ws.onclose = null;
      ws.onerror = null;
      clearTimeout(failTimer);
      try {
        ws.close();
      } catch (_) {}
    },
  };
}
