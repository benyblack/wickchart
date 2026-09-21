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
    else { const i = d.findIndex((x) => x.time >= b.time); if (i >= 0 && d[i].time === b.time) d[i] = b; else d.splice(i < 0 ? d.length : i, 0, b); }
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

test('explicit duration 0 is honored (0 disables, not 180)', () => {
  installRaf();
  const chart = new FakeChart();
  const anim = attachAnimate(chart, { duration: 0 });
  assert.equal(anim._dur, 0);
  anim.detach();
  const def = attachAnimate(chart);
  assert.equal(def._dur, 180);   // default
  def.detach();
  assert.equal(attachAnimate(chart, { duration: 4000 })._dur, 1500); // clamped
});

test('double-attach throws; detach is idempotent and never clobbers a foreign wrapper', () => {
  installRaf();
  const chart = new FakeChart();
  const orig = chart.update;
  const anim = attachAnimate(chart);
  assert.throws(() => attachAnimate(chart), TypeError);
  const foreign = function (b) { return FakeChart.prototype.update.call(chart, b); };
  chart.update = foreign;   // another plugin wraps over us
  anim.detach();
  assert.equal(chart.update, foreign); // ours is gone, theirs intact
  anim.detach();            // second detach: no-op
  assert.equal(chart.update, foreign);
  chart.update = orig;
});

test('eases the forming-bar close and lands on the exact true bar', () => {
  installRaf();
  const chart = new FakeChart();
  attachAnimate(chart); // default 180ms ease-out
  const last = chart.data[chart.data.length - 1];
  const bar = tickOn(last.time, 110);
  chart.update(bar);
  assert.equal(chart.writes.length, 0); // nothing until the first frame

  frame(1000); // t0 captured; k=0 writes the from value
  assert.equal(chart.writes.length, 1); // the k=0 write commits the new tick's facts at the held close
  assert.equal(chart.writes[0].close, 100);
  frame(1090); // k=0.5 → ease-out 108.75
  assert.ok(chart.writes[chart.writes.length - 1].close > 100);
  assert.ok(chart.writes[chart.writes.length - 1].close < 110);
  frame(1180); // k>=1 → the true bar, exactly
  const w = chart.writes[chart.writes.length - 1];
  assert.equal(w, bar); // identity: the exact tick object, not a copy
  assert.equal(w.close, 110);
  assert.equal(w.high, 101);
  assert.equal(w.volume, 60);
  assert.equal(rafQ.length, 0); // loop stopped
  assert.equal(chart.data[chart.data.length - 1].close, 110);
});

test('wick guard: the eased body never escapes high/low', () => {
  installRaf();
  const chart = new FakeChart();
  attachAnimate(chart, { easing: 'linear' }); // linear → k=0.5 is exactly the midpoint
  const last = chart.data[chart.data.length - 1];
  // a feed bar whose close exceeds its own high (malformed but must not break)
  chart.update(tickOn(last.time, 110, { high: 100 }));
  frame(1000); // t0 captured; k=0 writes the from value
  frame(1090); // k=0.5 → eased close 105 > high 100
  const w = chart.writes[chart.writes.length - 1];
  assert.equal(w.close, 105);
  assert.equal(w.high, 105); // clamped up around the eased body
  assert.equal(w.low, 99);   // and down
});

test('a detached wrapper is a hard passthrough (chain re-exposure safety)', () => {
  installRaf();
  const chart = new FakeChart();
  const anim = attachAnimate(chart);
  const stale = chart.update;
  anim.detach();
  chart.update = stale; // a foreign chain re-exposes our wrapper
  const last = chart.data[chart.data.length - 1];
  chart.update(tickOn(last.time, 111));
  assert.equal(chart.writes.length, 1);
  assert.equal(chart.writes[0].close, 111);
  assert.equal(rafQ.length, 0);
});

test('a nullish close passes through instead of easing toward 0', () => {
  installRaf();
  const chart = new FakeChart();
  attachAnimate(chart);
  const last = chart.data[chart.data.length - 1];
  chart.update({ ...tickOn(last.time, null) });
  assert.equal(chart.writes.length, 1);        // one passthrough write
  assert.equal(chart.writes[0].close, null);   // the exact bar, chart-side normalization decides
  assert.equal(rafQ.length, 0);                // no ease ever started
});

test('a re-entrant update during a frame write does not spawn a second loop', () => {
  installRaf();
  const chart = new FakeChart();
  // The hook must ride inside _orig — the function animate captured at attach —
  // so it is installed on the prototype BEFORE attachAnimate; the re-entrant
  // chart.update() models a synchronous listener firing on the frame write.
  const orig = FakeChart.prototype.update;
  let reentered = false;
  FakeChart.prototype.update = function (b) {
    orig.call(this, b);
    if (!reentered && this === chart) { reentered = true; chart.update(tickOn(b.time, 115)); }
  };
  try {
    const anim = attachAnimate(chart);
    const last = chart.data[chart.data.length - 1];
    chart.update(tickOn(last.time, 110)); // starts the ease
    frame(1000); // k=0 write fires the re-entrant tick — pre-fix this leaves TWO pending frames
    assert.equal(rafQ.length, 1);         // exactly one loop
    frame(1090); frame(1180); frame(1360); // let the retargeted ease settle
    anim.detach();
    assert.equal(rafQ.length, 0);
  } finally { FakeChart.prototype.update = orig; }
});

test('a re-entrant update during the detach flush lands as a fact, not a new ease', () => {
  installRaf();
  const chart = new FakeChart();
  // Same _orig seam as above, but armed only once the ease is active so the
  // re-entrant chart.update() fires from the FLUSH write, not a frame write.
  const orig = FakeChart.prototype.update;
  let armed = false;
  let reentered = false;
  FakeChart.prototype.update = function (b) {
    orig.call(this, b);
    if (armed && !reentered && this === chart) { reentered = true; chart.update(tickOn(b.time, 120)); }
  };
  try {
    const anim = attachAnimate(chart);
    const last = chart.data[chart.data.length - 1];
    chart.update(tickOn(last.time, 110));
    frame(1000); // ease active (the k=0 write; the hook is inert — not armed yet)
    armed = true;
    anim.detach(); // flush writes the true bar; the re-entrant tick must bypass _tick entirely
    frame(2000);   // drain: a live uncanceled loop would run here and reschedule
    assert.equal(rafQ.length, 0);
    assert.equal(chart.data[chart.data.length - 1].close, 120); // landed as a fact
  } finally { FakeChart.prototype.update = orig; }
});

test('retarget starts from the displayed ease value, not a stale data read', () => {
  installRaf();
  const chart = new FakeChart();
  attachAnimate(chart);
  const last = chart.data[chart.data.length - 1];
  chart.update(tickOn(last.time, 110));
  frame(1000);
  frame(1090); // ease-out k=0.5 → displaying 108.75
  // construct the divergent state the guard exists for: data says 102
  // (a write path that bypassed _tick), the ease is at 108.75
  chart._d[chart._d.length - 1] = { ...chart._d[chart._d.length - 1], close: 102 };
  chart.update(tickOn(last.time, 120)); // retarget
  frame(1180); // new t0, k=0 → writes the from value
  assert.equal(chart.writes[chart.writes.length - 1].close, 108.75); // never jumps back to 102
  frame(1360); // k>=1 → the true bar
  assert.equal(chart.data[chart.data.length - 1].close, 120);
});

test('a second tick mid-ease retargets without a jump — monotonic closes', () => {
  installRaf();
  const chart = new FakeChart();
  attachAnimate(chart);
  const last = chart.data[chart.data.length - 1];
  chart.update(tickOn(last.time, 110));
  frame(1000);                       // k=0 → 100
  frame(1090);                       // ease-out k=0.5 → 108.75
  chart.update(tickOn(last.time, 120)); // retarget from 108.75
  frame(1180);                       // new t0, k=0 → 108.75 again (no jump)
  assert.equal(chart.writes[chart.writes.length - 1].close, 108.75);
  frame(1270);                       // k=0.5 → 108.75 + 11.25 × 0.875 ≈ 118.59
  frame(1360);                       // k=1 → the true bar
  assert.equal(chart.writes[chart.writes.length - 1].close, 120);
  const closes = chart.writes.map((w2) => w2.close);
  assert.ok(closes.every((c, i) => i === 0 || c >= closes[i - 1])); // monotonic
});
