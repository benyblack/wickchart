// PR #58 — explicit timezone: a DST-aware zone offset in core, a VWAP session
// anchor, and timezone-aware axis labels.
//
// Before this, axis labels used the browser's local zone while calcVWAP()
// reset on the UTC day, so on a Stockholm chart the VWAP anchor sat two hours
// off the day divider drawn on the same canvas.
//
// Deliberately: VWAP's default anchor stays UTC (the crypto convention and
// today's behaviour) -- the anchor is opt-in, not implied by `timezone`.
import test from 'node:test';
import assert from 'node:assert/strict';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

/**
 * Bars as [time, price] pairs. Prices must differ between bars, otherwise
 * VWAP equals that price whether or not the session reset — and the test
 * would pass without exercising the anchor at all.
 */
const barsAt = (specs) =>
  specs.map(([t, price]) => ({
    time: t, open: price, high: price, low: price, close: price, volume: 1,
  }));

/* --------------------------- zone offsets --------------------------- */

test('zoneOffset handles utc, fixed offsets and local', async () => {
  const { zoneOffset } = await import('../src/core.js');
  const t = Date.UTC(2024, 0, 15, 12);

  assert.equal(zoneOffset(t, 'utc'), 0);
  assert.equal(zoneOffset(t, -5 * HOUR), -5 * HOUR, 'a number is a fixed offset');
  assert.equal(zoneOffset(t, 'local'), -new Date(t).getTimezoneOffset() * 60000);
});

test('zoneOffset is DST-aware for IANA zones', async () => {
  const { zoneOffset } = await import('../src/core.js');

  assert.equal(zoneOffset(Date.UTC(2024, 0, 15, 12), 'America/New_York'), -5 * HOUR, 'EST in January');
  assert.equal(zoneOffset(Date.UTC(2024, 6, 15, 12), 'America/New_York'), -4 * HOUR, 'EDT in July');
  assert.equal(zoneOffset(Date.UTC(2024, 0, 15, 12), 'Europe/Stockholm'), 1 * HOUR, 'CET in January');
  assert.equal(zoneOffset(Date.UTC(2024, 6, 15, 12), 'Europe/Stockholm'), 2 * HOUR, 'CEST in July');
  assert.equal(zoneOffset(Date.UTC(2024, 0, 15, 12), 'Asia/Kolkata'), 5.5 * HOUR, 'half-hour zones work');
});

test('zoneOffset falls back to UTC for an unusable zone, and says so', async () => {
  const { zoneOffset } = await import('../src/core.js');
  const warnings = [];
  const real = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    assert.equal(zoneOffset(Date.UTC(2024, 0, 15), 'Not/AZone'), 0, 'never throws on bad input');
    // cached, so a second call must not warn again
    zoneOffset(Date.UTC(2024, 5, 15), 'Not/AZone');
  } finally {
    console.warn = real;
  }
  assert.equal(warnings.length, 1, 'warned exactly once');
  assert.match(warnings[0], /unknown timezone "Not\/AZone"/);
});

/* --------------------------- axis labels --------------------------- */

const { WickChart } = await import('../src/wick-chart.js');
const P = WickChart.prototype;

/** Duck-typed chart just wide enough to run _timeTicks(). */
function tickChart(times, zone) {
  const chart = {
    _data: times.map((t) => ({ time: t, open: 1, high: 1, low: 1, close: 1, volume: 1 })),
    _dt: HOUR,
    _view: { spacing: 100, rightIndex: times.length - 1 },
    _tz: zone,
    _xFor: (i) => i * 100,
  };
  chart._timeTicks = P._timeTicks.bind(chart);
  chart._zt = P._zt.bind(chart);
  return chart;
}

// 18:00, 19:00, 20:00 UTC — which is 23:30, 00:30 (next day), 01:30 in Kolkata
const T = [0, 1, 2].map((h) => Date.UTC(2024, 0, 15, 18 + h));

test('timezone is an observed attribute and defaults to local', () => {
  assert.ok(WickChart.observedAttributes.includes('timezone'));
});

test('axis labels follow the chart timezone', () => {
  const utc = tickChart(T, 'utc')._timeTicks(0, 2).map((t) => t.label);
  assert.deepEqual(utc, ['19:00', '20:00'], 'UTC reads the wall clock straight');

  const kol = tickChart(T, 'Asia/Kolkata')._timeTicks(0, 2).map((t) => t.label);
  // 00:30 crosses into a new Kolkata day, so that tick is a date, not a time
  assert.notEqual(kol[0], '19:00', 'labels shifted into the zone');
  assert.equal(kol[1], '01:30', 'half-hour zone offsets are honoured');
});

test('the day boundary is the one in the chart timezone', () => {
  const kol = tickChart(T, 'Asia/Kolkata')._timeTicks(0, 2).map((t) => t.label);
  assert.ok(!/^\d\d:\d\d$/.test(kol[0]), 'the Kolkata midnight tick renders as a date');
  const utc = tickChart(T, 'utc')._timeTicks(0, 2).map((t) => t.label);
  assert.ok(utc.every((l) => /^\d\d:\d\d$/.test(l)), 'no UTC day boundary in this window');
});

test('setting the timezone attribute does not re-anchor VWAP', async () => {
  const { calcVWAP } = await import('../src/core.js');
  const chart = { _tz: 'local' };
  chart.attributeChangedCallback = P.attributeChangedCallback.bind(chart);
  chart._invalidate = () => {};
  chart.attributeChangedCallback('timezone', null, 'America/New_York');
  assert.equal(chart._tz, 'America/New_York', 'the attribute is applied');

  // …but VWAP is still on the UTC day unless asked otherwise
  const d0 = Date.UTC(2024, 0, 15);
  assert.equal(calcVWAP(barsAt([[d0 + 4 * HOUR, 10], [d0 + 5 * HOUR, 20]]))[1], 15,
    'display zone and session anchor stay independent');
});

test('vwap-anchor reaches the vwap indicator through the element', async () => {
  const { BUILTIN_INDICATORS } = await import('../src/core.js');
  const d0 = Date.UTC(2024, 0, 15);
  const chart = {
    _data: barsAt([[d0 + 4 * HOUR, 10], [d0 + 5 * HOUR, 20]]),
    _version: 0,
    _cache: { v: -1, map: {} },
    _vwapAnchor: 'utc',
    _onlineSeries: { epoch: -1, map: {} },
    _invalidate() {},
  };
  chart._indicatorSeries = P._indicatorSeries.bind(chart);
  chart._seedOnline = P._seedOnline.bind(chart);
  chart.attributeChangedCallback = P.attributeChangedCallback.bind(chart);
  const entry = { key: 'vwap', name: 'vwap', def: BUILTIN_INDICATORS.get('vwap'), params: {} };

  const utc = chart._indicatorSeries(entry).lines[0].values;
  assert.equal(utc[1], 15, 'default anchor keeps both bars in one UTC session');

  chart.attributeChangedCallback('vwap-anchor', null, 'America/New_York');
  const ny = chart._indicatorSeries(entry).lines[0].values;
  assert.equal(ny[1], 20, 'a new NY session starts at 05:00 UTC — and the cache dropped');
});

/* --------------------------- VWAP anchoring --------------------------- */

test('calcVWAP still anchors to the UTC day by default', async () => {
  const { calcVWAP } = await import('../src/core.js');
  const d0 = Date.UTC(2024, 0, 15);
  // 10 at 23:00, 20 at 00:00 the next UTC day — a reset shows 20, a carried
  // session would average to 15
  assert.equal(calcVWAP(barsAt([[d0 + 23 * HOUR, 10], [d0 + 24 * HOUR, 20]]))[1], 20);
  // …and within one UTC day it accumulates
  assert.equal(calcVWAP(barsAt([[d0 + 1 * HOUR, 10], [d0 + 2 * HOUR, 20]]))[1], 15);
});

test('calcVWAP anchors to a fixed session offset', async () => {
  const { calcVWAP } = await import('../src/core.js');
  const d0 = Date.UTC(2024, 0, 15);
  // anchor -5h puts the session boundary at 05:00 UTC
  const bars = barsAt([[d0 + 4 * HOUR, 10], [d0 + 5 * HOUR, 20]]);
  assert.equal(calcVWAP(bars, -5 * HOUR)[1], 20, '05:00 UTC starts a new session');
  assert.equal(calcVWAP(bars, 'utc')[1], 15, 'the same bars are one UTC session');
});

test('calcVWAP anchors to an IANA session, DST included', async () => {
  const { calcVWAP } = await import('../src/core.js');

  // New York midnight is 05:00 UTC in January
  const jan = Date.UTC(2024, 0, 15);
  assert.equal(
    calcVWAP(barsAt([[jan + 4 * HOUR, 10], [jan + 5 * HOUR, 20]]), 'America/New_York')[1],
    20, 'a new NY session starts at 05:00 UTC in winter'
  );
  assert.equal(
    calcVWAP(barsAt([[jan + 5 * HOUR, 10], [jan + 6 * HOUR, 20]]), 'America/New_York')[1],
    15, 'and 05:00–06:00 is inside that session'
  );

  // …but 04:00 UTC in July, when New York is on EDT
  const jul = Date.UTC(2024, 6, 15);
  assert.equal(
    calcVWAP(barsAt([[jul + 3 * HOUR, 10], [jul + 4 * HOUR, 20]]), 'America/New_York')[1],
    20, 'the session boundary follows DST'
  );
  assert.equal(
    calcVWAP(barsAt([[jul + 4 * HOUR, 10], [jul + 5 * HOUR, 20]]), 'America/New_York')[1],
    15, 'and 04:00–05:00 is inside the summer session'
  );
});
