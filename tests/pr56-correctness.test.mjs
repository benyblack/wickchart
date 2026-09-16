// PR #56 — correctness hardening around the real-time trading edge cases:
// repeating alerts, alert evaluation order, backfill suppression, and the
// seconds-vs-milliseconds timestamp heuristic.
//
// These are behavioural tests: they drive the real prototype methods over a
// duck-typed chart (the idiom the layer/presence tests already use) rather
// than asserting on source text, because every bug fixed here passed the
// existing source-shape and pure-function tests while being broken at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';

const { WickChart } = await import('../src/wick-chart.js');
const P = WickChart.prototype;

/** A minimal object satisfying the slice of the element contract alerts touch. */
function makeChart(bars = []) {
  const chart = {
    _alerts: [],
    _seq: 0,
    _cache: { v: -1, map: {} },
    _version: 0,
    _data: bars,
    _hover: null,
    _dt: 3600e3,
    _alertEval: 'live',
    _onlineSeries: { epoch: -1, map: {} },
    _lastClosedIdx: -1,
    fires: [],
    _invalidate() {},
    _computeDt() {},
    _updateAria() {},
    _fire(name, detail) { this.fires.push({ name, ...detail }); },
  };
  for (const m of [
    'addAlert', '_checkAlerts', '_predicateCache', 'update', '_fireAlert',
    '_onlineTick',
    '_lastClosedIndex', '_syncClosedIdx', '_evalMode',
  ]) {
    chart[m] = P[m].bind(chart);
  }
  chart._syncClosedIdx(); // baseline, as setData() does on the real element
  return chart;
}

const mkBars = (closes, t0 = 1_700_000_000_000) =>
  closes.map((c, i) => ({
    time: t0 + i * 3600e3,
    open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 100,
  }));

/* ------------------------- repeating price alerts ------------------------- */

test('a once:false price alert fires on every crossing, not just the first', () => {
  const chart = makeChart();
  chart.addAlert({ id: 'repeating', price: 100, direction: 'cross', once: false });

  // up through 100, back down through 100, up through 100 again
  for (const [prev, cur] of [[99, 101], [101, 99], [99, 101]]) {
    chart._checkAlerts(prev, { time: Date.now(), close: cur });
  }

  assert.equal(chart.fires.length, 3, 'three crossings produce three alerts');
  assert.ok(chart.fires.every((f) => f.id === 'repeating'));
  assert.equal(chart._alerts.length, 1, 'the alert stays registered');
});

test('a once:true price alert fires once and is removed', () => {
  const chart = makeChart();
  chart.addAlert({ id: 'single', price: 100, direction: 'cross', once: true });

  for (const [prev, cur] of [[99, 101], [101, 99], [99, 101]]) {
    chart._checkAlerts(prev, { time: Date.now(), close: cur });
  }

  assert.equal(chart.fires.length, 1, 'only the first crossing fires');
  assert.equal(chart._alerts.length, 0, 'a once-alert drops out of the list');
});

/* ---------------------------- rebrand residue ---------------------------- */

test('elementName reports the tag the class is actually registered as', () => {
  assert.equal(WickChart.elementName, 'wick-chart');
});

/* ------------------------- closed-candle alerts ------------------------- */

test('a bar carries `closed` only when the feed says so', () => {
  const plain = WickChart._normBar({ time: 1, open: 1, high: 2, low: 0, close: 1.5, volume: 1 });
  assert.ok(!('closed' in plain), 'bar shape is unchanged when no flag is supplied');
  const final = WickChart._normBar({ time: 1, open: 1, high: 2, low: 0, close: 1.5, volume: 1, closed: true });
  assert.equal(final.closed, true, 'an explicit final candle is marked');
});

test("evaluate:'close' does not fire on the still-forming candle", () => {
  const chart = makeChart(mkBars([90, 90]));
  chart.addAlert({ id: 'ta', when: 'close > 100', once: false, evaluate: 'close' });

  // a new forming bar breaks 100 — but it is not final yet
  chart.update({ time: 1_700_000_000_000 + 2 * 3600e3, open: 90, high: 111, low: 90, close: 110, volume: 1 });
  assert.equal(chart.fires.length, 0, 'the forming candle is not a signal');

  // the next bar arrives, so the 110 candle is now final
  chart.update({ time: 1_700_000_000_000 + 3 * 3600e3, open: 110, high: 116, low: 110, close: 115, volume: 1 });
  assert.equal(chart.fires.length, 1, 'the candle closed above 100 — now it fires');
});

test("evaluate:'close' fires immediately on an explicitly final candle", () => {
  const chart = makeChart(mkBars([90, 90]));
  chart.addAlert({ id: 'ta', when: 'close > 100', once: false, evaluate: 'close' });

  // the Binance k.x path: the feed tells us this candle is final
  chart.update({ time: 1_700_000_000_000 + 2 * 3600e3, open: 90, high: 111, low: 90, close: 110, volume: 1, closed: true });

  assert.equal(chart.fires.length, 1, 'no need to wait for the next candle');
});

test("the default stays 'live' and fires on the forming candle", () => {
  const chart = makeChart(mkBars([90, 90]));
  chart.addAlert({ id: 'ta', when: 'close > 100', once: false });

  chart.update({ time: 1_700_000_000_000 + 2 * 3600e3, open: 90, high: 111, low: 90, close: 110, volume: 1 });

  assert.equal(chart.fires.length, 1, 'existing 1.x behaviour is unchanged');
});

test("evaluate:'close' applies to price alerts too", () => {
  const chart = makeChart(mkBars([90, 90]));
  chart.addAlert({ id: 'px', price: 100, direction: 'cross', once: false, evaluate: 'close' });

  chart.update({ time: 1_700_000_000_000 + 2 * 3600e3, open: 90, high: 111, low: 90, close: 110, volume: 1 });
  assert.equal(chart.fires.length, 0, 'a forming candle crossing 100 is not final');

  chart.update({ time: 1_700_000_000_000 + 3 * 3600e3, open: 110, high: 116, low: 110, close: 115, volume: 1 });
  assert.equal(chart.fires.length, 1, 'the crossing is confirmed on close');
});

test('loading data does not retroactively fire close-mode alerts', () => {
  const chart = makeChart([]);
  chart.setData = P.setData.bind(chart);
  chart._autoAttr = () => true;
  chart.clearBrush = () => {};
  chart.addAlert({ id: 'ta', when: 'close > 100', once: false, evaluate: 'close' });

  chart.setData(mkBars([90, 150, 160])); // history already satisfies the predicate

  assert.equal(chart.fires.length, 0, 'history is not a live signal');
});

test('alert-evaluate sets the chart-level default, overridable per alert', () => {
  assert.ok(
    WickChart.observedAttributes.includes('alert-evaluate'),
    'the attribute is observed'
  );

  const chart = makeChart(mkBars([90, 90]));
  chart.attributeChangedCallback = P.attributeChangedCallback.bind(chart);
  chart.attributeChangedCallback('alert-evaluate', null, 'close');

  const inherited = chart._alerts[chart.addAlert({ when: 'close > 1' }) && 0];
  assert.equal(inherited.evaluate, 'close', 'an alert with no evaluate inherits the default');

  chart.addAlert({ id: 'override', when: 'close > 1', evaluate: 'live' });
  assert.equal(chart._alerts[1].evaluate, 'live', 'an explicit mode still wins');
});

test('an unknown alert-evaluate value falls back to live', () => {
  const chart = makeChart(mkBars([90, 90]));
  chart.attributeChangedCallback = P.attributeChangedCallback.bind(chart);
  chart.attributeChangedCallback('alert-evaluate', null, 'nonsense');
  chart.addAlert({ when: 'close > 1' });
  assert.equal(chart._alerts[0].evaluate, 'live');
});

test('an alert keeps its evaluate mode across getState/setState', () => {
  const chart = makeChart(mkBars([90, 90]));
  chart._positions = [];
  chart._ind = { volume: false, overlays: [], panes: [] };
  chart._type = 'candles';
  chart._theme = 'dark';
  chart.getVisibleRange = () => null;
  chart.getState = P.getState.bind(chart);
  chart.addAlert({ id: 'ta', when: 'close > 100', evaluate: 'close' });
  chart.addAlert({ id: 'px', price: 100, evaluate: 'close' });

  const saved = chart.getState().alerts;
  assert.equal(saved[0].evaluate, 'close', 'scripted alert persists its mode');
  assert.equal(saved[1].evaluate, 'close', 'price alert persists its mode');

  const restored = makeChart(mkBars([90, 90]));
  restored.setState = P.setState.bind(restored);
  restored.setAttribute = () => {};
  restored.toggleAttribute = () => {};
  restored._positions = [];
  restored.setState({ alerts: saved });

  assert.equal(restored._alerts[0].evaluate, 'close', 'scripted mode survives the round trip');
  assert.equal(restored._alerts[1].evaluate, 'close', 'price mode survives the round trip');
});

test('the Binance socket forwards the final-candle flag', async () => {
  const { openBinanceSocket } = await import('../src/feeds.js');
  const sockets = [];
  globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); }
    close() {}
  };
  globalThis.WebSocket.OPEN = 1;

  const bars = [];
  try {
    // close() clears the socket's failover timer, which would otherwise
    // outlive the test and fire against a deleted global
    const handle = openBinanceSocket('BTCUSDT', '1h', (b) => bars.push(b), () => {});
    const ws = sockets[0];
    ws.onmessage({ data: JSON.stringify({ k: { t: 1, o: '1', h: '2', l: '0', c: '1.5', v: '9', x: false } }) });
    ws.onmessage({ data: JSON.stringify({ k: { t: 1, o: '1', h: '2', l: '0', c: '1.6', v: '9', x: true } }) });
    handle.close();
  } finally {
    delete globalThis.WebSocket;
  }

  assert.equal(bars.length, 2);
  assert.ok(!bars[0].closed, 'a forming kline is not final');
  assert.equal(bars[1].closed, true, 'k.x true marks the candle final');
});

/* --------------------- WickScript window performance --------------------- */

test('hh/ll match a naive rolling window, including warm-up gaps', async () => {
  const { evalScript } = await import('../src/core.js');
  const closes = [5, 3, 9, 9, 1, 7, 4, 4, 8, 2, 6];
  const bars = mkBars(closes);
  const naive = (vals, p, pick) =>
    vals.map((_, i) => (i < p - 1 ? NaN : vals.slice(i - p + 1, i + 1).reduce(pick)));

  for (const p of [1, 2, 3, 5, closes.length, closes.length + 3]) {
    assert.deepEqual(
      evalScript(`hh(close,${p})`, bars),
      naive(closes, p, (a, b) => Math.max(a, b)),
      `hh window ${p}`
    );
    assert.deepEqual(
      evalScript(`ll(close,${p})`, bars),
      naive(closes, p, (a, b) => Math.min(a, b)),
      `ll window ${p}`
    );
  }
});

test('a window containing a warm-up gap stays NaN', async () => {
  const { evalScript } = await import('../src/core.js');
  const bars = mkBars([1, 2, 3, 4, 5, 6]);
  // sma(close,3) is NaN for the first two bars; hh over it must not report
  // a max computed from a partially-warm window
  const v = evalScript('hh(sma(close,3), 3)', bars);
  assert.ok(Number.isNaN(v[2]), 'window still overlaps the warm-up gap');
  assert.ok(Number.isNaN(v[3]), 'window still overlaps the warm-up gap');
  assert.equal(v[4], 4, 'first fully-warm window'); // sma over [2,3,4]=3, [3,4,5]=4 → max 4
});

test('a large rolling window stays linear, not quadratic', async () => {
  const { evalScript, compileScript } = await import('../src/core.js');
  const n = 100000;
  const bars = mkBars(Array.from({ length: n }, (_, i) => 100 + Math.sin(i) * 10));
  const compiled = compileScript(`hh(close,${n / 2})`);

  const t0 = performance.now();
  evalScript(compiled, bars);
  const ms = performance.now() - t0;

  // O(n*p) here is ~5e9 comparisons (~1.6s measured). O(n) is a couple of ms,
  // so 150ms sits an order of magnitude clear of both outcomes.
  assert.ok(ms < 150, `hh over a 50k window took ${ms.toFixed(0)}ms — expected linear time`);
});

/* ------------------------- position P&L percent ------------------------- */

test('percent return is independent of position size', async () => {
  const { positionPnlPct } = await import('../src/core.js');
  // entry 100 → price 110 is +10%, however many units you hold
  for (const qty of [1, 10, 0.25]) {
    assert.equal(positionPnlPct({ side: 'long', entry: 100, qty }, 110), 10, `qty ${qty}`);
  }
});

test('percent return is signed by side', async () => {
  const { positionPnlPct } = await import('../src/core.js');
  assert.equal(positionPnlPct({ side: 'short', entry: 100, qty: 3 }, 90), 10, 'short profits as price falls');
  assert.equal(positionPnlPct({ side: 'long', entry: 100, qty: 3 }, 90), -10, 'long loses as price falls');
});

test('percent return is 0 for an unusable entry', async () => {
  const { positionPnlPct } = await import('../src/core.js');
  assert.equal(positionPnlPct({ side: 'long', entry: 0 }, 110), 0);
  assert.equal(positionPnlPct(null, 110), 0);
});

test('the HUD chip shows monetary P&L and percent return separately', () => {
  const chart = makeChart(mkBars([100, 110]));
  chart._positions = [{ id: 'p1', side: 'long', entry: 100, qty: 10 }];
  chart._poss = { innerHTML: '' };
  chart._precision = 2;
  chart._prec = P._prec.bind(chart);
  P._updateHud.call(chart);

  const html = chart._poss.innerHTML;
  assert.match(html, /\+100\b/, 'monetary P&L scales with the 10 units held');
  assert.match(html, /\+10\.00%/, 'percent return does not');
});

/* --------------------- seconds vs milliseconds --------------------- */

test('a pre-2001 millisecond timestamp survives normalization', () => {
  const t = Date.UTC(1999, 11, 31); // 946598400000 — below the old 1e12 cutoff
  const b = WickChart._normBar({ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 });
  assert.equal(b.time, t, 'a 1999 ms timestamp is not mistaken for seconds');
  assert.equal(new Date(b.time).getUTCFullYear(), 1999);
});

test('a seconds timestamp is still upscaled to milliseconds', () => {
  const secs = Math.floor(Date.UTC(2021, 5, 1) / 1000); // 1622505600
  const b = WickChart._normBar({ time: secs, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 });
  assert.equal(b.time, secs * 1000);
  assert.equal(new Date(b.time).getUTCFullYear(), 2021);
});

test('a Date is accepted as an unambiguous timestamp', () => {
  const d = new Date(Date.UTC(1962, 0, 15)); // predates any numeric heuristic
  const b = WickChart._normBar({ time: d, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 });
  assert.equal(b.time, d.getTime());
  assert.equal(new Date(b.time).getUTCFullYear(), 1962);
});

test('core and the element agree on what a timestamp means', async () => {
  const { toMs } = await import('../src/core.js');
  for (const t of [Date.UTC(1999, 11, 31), Date.UTC(2024, 0, 1), 1622505600, 0]) {
    assert.equal(toMs(t), WickChart._timeToMs(t), `same reading of ${t}`);
  }
});

test('VWAP anchors pre-2001 bars to the right day', async () => {
  const { calcVWAP } = await import('../src/core.js');
  const day1 = Date.UTC(1999, 11, 30);
  // two bars on one day, one on the next: VWAP resets on the day change
  const bars = [
    { time: day1, high: 10, low: 10, close: 10, volume: 1 },
    { time: day1 + 3600e3, high: 20, low: 20, close: 20, volume: 1 },
    { time: day1 + 24 * 3600e3, high: 30, low: 30, close: 30, volume: 1 },
  ];
  const v = calcVWAP(bars);
  assert.equal(v[1], 15, 'second bar averages with the first');
  assert.equal(v[2], 30, 'the new day resets the anchor');
});

test('the plugins read timestamps the same way the chart does', async () => {
  const t = Date.UTC(1999, 11, 31); // a real ms timestamp below the old cutoff
  const { normalizeSeries } = await import('../plugins/compare/core.mjs');
  const { normalizeDrawings } = await import('../plugins/draw/core.mjs');
  const { normalizeTrades } = await import('../plugins/tape/core.mjs');

  const [series] = normalizeSeries([{ label: 'A', data: [{ time: t, close: 10 }] }]);
  assert.equal(series.samples[0][0], t, 'compare: 1999 bar time preserved');

  const [drawing] = normalizeDrawings([{ type: 'hline', points: [{ t, p: 100 }] }]);
  assert.equal(drawing.points[0].t, t, 'draw: 1999 anchor preserved');

  const [trade] = normalizeTrades([{ time: t, price: 10, size: 1, side: 'buy' }]);
  assert.equal(trade.time, t, 'tape: 1999 print preserved');
});

/* ------------------- alert evaluation order & backfill ------------------- */

test('a scripted alert sees the incoming bar on the update that delivers it', () => {
  const chart = makeChart(mkBars([90, 90]));
  chart.addAlert({ id: 'breakout', when: 'close > 100', once: false });

  chart.update({ time: 1_700_000_000_000 + 2 * 3600e3, open: 90, high: 111, low: 90, close: 110, volume: 1 });

  assert.equal(chart.fires.length, 1, 'fires on the update carrying the breakout, not the next one');
  const ev = chart.fires[0];
  assert.equal(ev.id, 'breakout');
  assert.equal(ev.when, 'close > 100', 'the event carries the predicate source');
  assert.equal(ev.price, 110, 'and the price that triggered it');
  assert.equal(ev.bar.close, 110, 'and the bar it evaluated');
});

test('appending a bar still fires a price alert on a real crossing', () => {
  const chart = makeChart(mkBars([90, 90]));
  chart.addAlert({ id: 'cross100', price: 100, direction: 'cross', once: false });

  chart.update({ time: 1_700_000_000_000 + 2 * 3600e3, open: 90, high: 111, low: 90, close: 110, volume: 1 });

  assert.equal(chart.fires.length, 1, 'a genuine upward crossing fires');
});

test('a backfilled historical bar does not fire live price alerts', () => {
  const chart = makeChart(mkBars([100, 100, 100]));
  chart.addAlert({ id: 'cross95', price: 95, direction: 'cross', once: false });

  // a correction for a bar BEFORE the current front of the series
  chart.update({ time: 1_700_000_000_000 - 3600e3, open: 90, high: 91, low: 89, close: 90, volume: 1 });

  assert.equal(chart.fires.length, 0, 'historical corrections are not live signals');
  assert.equal(chart._data.length, 4, 'but the bar is still inserted');
  assert.equal(chart._data[0].close, 90, 'inserted in time order at the front');
});

test('replacing the still-forming last bar can fire a price alert', () => {
  const chart = makeChart(mkBars([90, 90]));
  chart.addAlert({ id: 'cross100', price: 100, direction: 'cross', once: false });
  const lastTime = chart._data[chart._data.length - 1].time;

  // same timestamp → the forming candle ticks up through 100
  chart.update({ time: lastTime, open: 90, high: 111, low: 89, close: 110, volume: 2 });

  assert.equal(chart.fires.length, 1, 'the forming candle crossing 100 is a live signal');
  assert.equal(chart._data.length, 2, 'the bar was replaced, not appended');
});

/* ------------------------- React data identity ------------------------- */

/**
 * Stand-in for <wick-chart> that reproduces the REAL setData() contract: the
 * element normalizes the incoming array into a fresh one, so `el.data` never
 * equals the array React passed in. (The existing pr18 fake stores the array
 * as-is, which is what let the re-ingest bug hide.)
 */
function makeElementStub() {
  return {
    setDataCalls: 0,
    _data: [],
    get data() { return this._data; },
    setData(bars) {
      this.setDataCalls++;
      this._data = bars.map((b) => ({ ...b })); // normalization → new identity
    },
    hasAttribute: () => false,
    getAttribute: () => null,
    setAttribute() {},
    removeAttribute() {},
  };
}

test('re-rendering with the same bars array does not re-ingest the data', async () => {
  const { applyChartProps } = await import('../src/react-core.js');
  const el = makeElementStub();
  const bars = mkBars([10, 11, 12]);

  for (let i = 0; i < 3; i++) applyChartProps(el, { attrs: {}, data: bars });

  assert.equal(el.setDataCalls, 1, 'identical array reference ingests exactly once');
});

test('re-rendering with a fresh bars array does re-ingest the data', async () => {
  const { applyChartProps } = await import('../src/react-core.js');
  const el = makeElementStub();

  applyChartProps(el, { attrs: {}, data: mkBars([10, 11, 12]) });
  applyChartProps(el, { attrs: {}, data: mkBars([10, 11, 12, 13]) });

  assert.equal(el.setDataCalls, 2, 'a new array reference is a real update');
  assert.equal(el.data.length, 4, 'the newest bars won');
});

test('a once:false scripted alert re-arms on a falling edge', () => {
  const chart = makeChart();
  chart.addAlert({ id: 'scripted', when: 'close > 100', once: false });

  // close walks above 100, back below, and above again — two rising edges
  const closes = [90, 110, 120, 90, 110];
  for (let i = 1; i <= closes.length; i++) {
    chart._data = mkBars(closes.slice(0, i));
    chart._version++;
    chart._checkAlerts(closes[i - 2], chart._data[i - 1]);
  }

  assert.equal(chart.fires.length, 2, 'two rising edges produce two alerts');
});
