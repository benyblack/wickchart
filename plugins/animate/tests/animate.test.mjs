// wickchart-animate — the easing engine over a fake chart + a pumped rAF:
// wrap/intercept/passthrough/retarget/flush/cancel all pinned without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachAnimate } from '../animate.mjs';

const T0 = 1_700_000_000_000;
const DT = 60_000;
const bars = Array.from({ length: 10 }, (_, i) => ({
  time: T0 + i * DT, open: 100, high: 101, low: 99, close: 100, volume: 50,
}));

class FakeChart {
  constructor() { this._d = bars.slice(); this.writes = []; }
  get data() { return this._d; }
  setData(b) { this._d = b; }
  update(b) {
    this.writes.push(b);
    const d = this._d, last = d[d.length - 1];
    if (last && b.time === last.time) d[d.length - 1] = b;
    else if (!last || b.time > last.time) d.push(b);
    else { const i = d.findIndex((x) => x.time === b.time); if (i >= 0) d[i] = b; else d.splice(0, 0, b); }
  }
}

// rAF stub the tests pump by hand: deterministic frame timestamps
let rafQ = [];
const installRaf = () => {
  rafQ = [];
  globalThis.requestAnimationFrame = (fn) => (rafQ.push(fn), rafQ.length);
  globalThis.cancelAnimationFrame = (id) => { if (rafQ[id - 1] !== undefined) rafQ[id - 1] = null; };
};
const frame = (t) => { const q = rafQ; rafQ = []; for (const fn of q) if (fn) fn(t); };

const tickOn = (time, close, over = {}) => ({ time, open: 100, high: 101, low: 99, close, volume: 60, ...over });

test('attachAnimate throws on a non-chart', () => {
  assert.throws(() => attachAnimate(null), TypeError);
  assert.throws(() => attachAnimate({}), TypeError);
});

test('wraps chart.update; detach restores the original', () => {
  installRaf();
  const chart = new FakeChart();
  const orig = chart.update;
  const anim = attachAnimate(chart, { duration: 0 });
  assert.notEqual(chart.update, orig);
  anim.detach();
  assert.equal(chart.update, orig);
});

test('duration 0 is a hard passthrough — one write, the exact bar, no frames', () => {
  installRaf();
  const chart = new FakeChart();
  attachAnimate(chart, { duration: 0 });
  const last = chart.data[chart.data.length - 1];
  const bar = tickOn(last.time, 105);
  chart.update(bar);
  assert.equal(chart.writes.length, 1);
  assert.equal(chart.writes[0], bar);
  assert.equal(chart.data[chart.data.length - 1].close, 105);
  frame(1000); // nothing scheduled
  assert.equal(chart.writes.length, 1);
});

test('prefers-reduced-motion is a hard passthrough', () => {
  installRaf();
  const mm = { matches: true, addEventListener() {}, removeEventListener() {} };
  globalThis.matchMedia = () => mm;
  try {
    const chart = new FakeChart();
    attachAnimate(chart);
    const last = chart.data[chart.data.length - 1];
    chart.update(tickOn(last.time, 107));
    assert.equal(chart.writes.length, 1);
    assert.equal(chart.writes[0].close, 107);
  } finally { delete globalThis.matchMedia; }
});
