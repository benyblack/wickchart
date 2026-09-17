// wickchart-coview — the attach layer: room join/leave through the
// documentated element seams, the pairing protocol end to end (two charts
// over an injected transport), presence heartbeat + sweep, detach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { attachCoview } from '../coview.mjs';
const { WickChart } = await import('../../../src/wick-chart.js');

const read = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');

const bars = (n = 50) =>
  Array.from({ length: n }, (_, i) => ({
    time: 1700000000000 + i * 3600e3,
    open: 10, high: 11, low: 9, close: 10.5, volume: 100,
  }));
const T = (i) => 1700000000000 + i * 3600e3;
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** Deterministic in-memory transport: rooms of channels that deliver to
 *  everyone else in the room (like BroadcastChannel, minus the browser). */
function channelHub() {
  const rooms = new Map();
  const factory = (name) => {
    const ch = {
      room: name,
      closed: false,
      sent: [],
      onmessage: null,
      postMessage(msg) {
        if (this.closed) throw new Error('postMessage on a closed channel');
        this.sent.push(msg);
        for (const other of rooms.get(name) || []) {
          if (other !== this && !other.closed && other.onmessage) {
            setTimeout(() => other.onmessage({ data: msg }), 0);
          }
        }
      },
      close() {
        this.closed = true;
        rooms.get(name)?.delete(this);
      },
    };
    if (!rooms.has(name)) rooms.set(name, new Set());
    rooms.get(name).add(ch);
    return ch;
  };
  return { factory, rooms };
}

function coviewChart(hub, { room = 'room', label = null, beatMs = 60000, ttl } = {}) {
  const events = [];
  const c = {
    events,
    invalidations: 0,
    _connected: true,
    _coviewName: room,
    _coviewLabel: label,
    _data: bars(50),
    _ghost: null,
    _ghostTimer: 0,
    _coviewCh: null,
    _coviewBeat: 0,
    _presence: null,
    _range: { from: T(10), to: T(40) },
    getVisibleRange() { return { ...this._range }; },
    _invalidate() { this.invalidations++; },
    dispatchEvent(e) { events.push({ name: e.type, detail: e.detail }); return true; },
  };
  c.data = c._data;
  attachCoview(c, { channel: hub.factory, beatMs, ttl });
  return c;
}

/** Charts only announce on join/pan/heartbeat — drain the room and the
 *  pending deliveries, then release the heartbeat timers. */
const settle = async (...charts) => {
  for (const c of charts) c._coviewSendView(true);
  await tick();
};
const stopBeats = (...charts) => {
  for (const c of charts) {
    clearInterval(c._coviewBeat);
    clearTimeout(c._ghostTimer);
  }
};

/* ------------------------- attach / validation ------------------------- */

test('attachCoview validates the surface and is idempotent', () => {
  assert.throws(() => attachCoview(null), TypeError);
  assert.throws(() => attachCoview({ getVisibleRange() {}, dispatchEvent() {} }), TypeError, 'no _invalidate seam');
  const hub = channelHub();
  const c = coviewChart(hub);
  const again = attachCoview(c, { channel: hub.factory });
  assert.ok(again === c._wickCoview, 'second attach returns the same controller');
  for (const m of ['getPeers', '_setupCoView', '_coviewSend', '_coviewSendView', '_onCoMessage']) {
    assert.ok(c.hasOwnProperty(m), `${m} installed as an own property`);
  }
  assert.ok(c._presence && typeof c._presence.list === 'function', 'element presence state points at the plugin tracker');
  stopBeats(c);
});

test('joining a room announces the viewport immediately (v1 envelope)', () => {
  const hub = channelHub();
  const c = coviewChart(hub, { room: 'warroom', label: 'Maya' });
  const ch = hub.rooms.get('warroom');
  assert.equal(ch?.size, 1, 'one channel in the room');
  assert.equal(c._coviewCh.sent.length, 1, 'hello view posted at join');
  assert.deepEqual(
    c._coviewCh.sent[0],
    { v: 1, peer: c._coviewCh.sent[0].peer, type: 'view', from: T(10), to: T(40), name: 'Maya' }
  );
  assert.match(c._coviewCh.sent[0].peer, /^p/, 'random per-chart peer id');
  assert.notEqual(c._coviewBeat, 0, 'heartbeat scheduled on the element seam');
  stopBeats(c);
});

test('additive phase: the core element still carries its own machinery', () => {
  for (const m of ['getPeers', '_setupCoView', '_coviewSend', '_coviewSendView', '_onCoMessage']) {
    assert.equal(typeof WickChart.prototype[m], 'function', `core prototype still has ${m}`);
  }
});

/* ------------------------- pairing ------------------------- */

test('two charts in one room see each other (bands source + wick:peers)', async () => {
  const hub = channelHub();
  const a = coviewChart(hub, { room: 'pair', label: 'A' });
  const b = coviewChart(hub, { room: 'pair', label: 'B' });
  await tick();
  // B announced at join, so A sees B immediately; A announced before B was
  // in the room, so B learns about A at A's next broadcast (pan/heartbeat)
  assert.deepEqual(a.getPeers().map((p) => p.name), ['B']);
  assert.deepEqual(b.getPeers(), [], 'presence is eventual, not retroactive');
  a._coviewSendView(true);
  await tick();
  assert.deepEqual(b.getPeers().map((p) => p.name), ['A']);
  assert.deepEqual(b.getPeers()[0].range, { from: T(10), to: T(40) }, 'peer viewport carried');
  for (const c of [a, b]) {
    const joins = c.events.filter((e) => e.name === 'wick:peers' && e.detail.joined.length);
    assert.equal(joins.length, 1, 'one membership event per chart');
    assert.ok(c.invalidations >= 1, 'peer arrival repaints for the band');
  }
  // moving the viewport updates the band data without re-firing membership
  const aMoves = a.events.filter((e) => e.name === 'wick:peers').length;
  b._range = { from: T(0), to: T(20) };
  b._coviewSendView(true);
  await tick();
  assert.deepEqual(a.getPeers()[0].range, { from: T(0), to: T(20) }, 'band follows the move');
  assert.equal(a.events.filter((e) => e.name === 'wick:peers').length, aMoves, 'moves are not membership events');
  stopBeats(a, b);
});

test('view throttles to ~8/s unless forced', async () => {
  const hub = channelHub();
  const c = coviewChart(hub);
  const before = c._coviewCh.sent.length;
  c._coviewSendView(false); // <120ms after the join announcement → throttled
  assert.equal(c._coviewCh.sent.length, before, 'throttled right after a send');
  c._range = { from: T(1), to: T(2) };
  c._coviewSendView(true); // force bypasses the window
  assert.equal(c._coviewCh.sent.length, before + 1);
  assert.equal(c._coviewCh.sent.at(-1).from, T(1));
  stopBeats(c);
});

test('cross messages drive the ghost crosshair; leave clears it', () => {
  const hub = channelHub();
  const c = coviewChart(hub);
  c._onCoMessage({ v: 1, peer: 'p2', type: 'cross', time: T(20), yFrac: 0.5 });
  assert.equal(c._ghost.index, 20);
  assert.equal(c._ghost.yFrac, 0.5);
  clearTimeout(c._ghostTimer);
  c._onCoMessage({ v: 1, peer: 'p2', type: 'cross', time: null, yFrac: null });
  assert.equal(c._ghost, null, 'pointer-leave clears the ghost');

  c._onCoMessage({ v: 1, peer: 'p2', type: 'cross', time: T(30), yFrac: 2 }); // yFrac clamps
  assert.equal(c._ghost.yFrac, 1);
  stopBeats(c);
});

test('bye / wrong version / unknown types / self echoes never throw or track', () => {
  const hub = channelHub();
  const c = coviewChart(hub);
  const self = c._coviewCh.sent[0].peer;
  c._onCoMessage({ v: 1, peer: 'p2', type: 'view', from: T(5), to: T(9), name: 'maya' });
  c._onCoMessage({ v: 1, peer: 'p2', type: 'bye' });
  assert.equal(c.getPeers().length, 0, 'bye removes the peer');
  assert.equal(c.events.filter((e) => e.name === 'wick:peers' && e.detail.left.length).length, 1, 'left event fired');

  c._onCoMessage({ v: 2, peer: 'p3', type: 'view', from: 0, to: 1 });
  c._onCoMessage({ v: 1, peer: 'p3', type: 'future-thing' });
  c._onCoMessage({ v: 1, peer: self, type: 'view', from: 0, to: 1 });
  c._onCoMessage(null);
  assert.equal(c.getPeers().length, 0, 'nothing tracked');
  stopBeats(c);
});

/* ------------------------- lifecycle ------------------------- */

test('attribute change re-joins silently; disconnect + reconnect mirror the element lifecycle', () => {
  const hub = channelHub();
  const c = coviewChart(hub, { room: 'one' });
  const first = c._coviewCh;
  // what core's attributeChangedCallback does for a `co-view` change:
  c._coviewName = 'two';
  c._setupCoView();
  assert.equal(first.closed, true, 'old channel closed');
  assert.ok(!first.sent.some((m) => m.type === 'bye'), 'a re-join does not say goodbye (matches core)');
  assert.equal(hub.rooms.get('two').size, 1, 'new room joined');
  assert.equal(c._coviewCh.room, 'two');

  // disconnect: what disconnectedCallback drives
  c._connected = false;
  c._setupCoView();
  assert.equal(c._coviewCh, null, 'no channel while disconnected');
  assert.equal(c._coviewBeat, 0);
  // reconnect: what connectedCallback drives
  c._connected = true;
  c._setupCoView();
  assert.ok(c._coviewCh && c._coviewCh.room === 'two', 'rejoined on reconnect');
  clearInterval(c._coviewBeat);
});

test('heartbeat keeps presence warm and sweeps silent peers', async (t) => {
  const hub = channelHub();
  const a = coviewChart(hub, { room: 'sweep', beatMs: 150, ttl: 400 });
  t.after(() => stopBeats(a)); // release the heartbeat even if an assert throws
  // a peer joins then goes silent (tracked via a direct message)
  a._onCoMessage({ v: 1, peer: 'p9', type: 'view', from: T(1), to: T(5), name: null });
  assert.equal(a.getPeers().length, 1);
  const hello = a._coviewCh.sent.length;
  // the tracker clamps ttl to a 1s floor, so p9 outlives the first beats
  await tick(1500);
  assert.ok(a._coviewCh.sent.length > hello + 1, 'heartbeats kept flowing');
  const left = a.events.filter((e) => e.name === 'wick:peers' && e.detail.left.length);
  assert.ok(left.some((e) => e.detail.left[0].id === 'p9'), 'silent peer swept with an event');
  assert.equal(a.getPeers().length, 0);
});

test('detach: goodbye, close, shadows removed, clean slate', async () => {
  const hub = channelHub();
  const a = coviewChart(hub, { room: 'bye', label: 'A' });
  const b = coviewChart(hub, { room: 'bye', label: 'B' });
  await settle(a, b); // both sides know each other before the goodbye
  const aCh = a._coviewCh;
  const ctl = a._wickCoview;
  ctl.detach();
  assert.ok(aCh.sent.some((m) => m.type === 'bye'), 'goodbye sent before the close');
  assert.equal(aCh.closed, true, 'channel closed');
  assert.equal(a._coviewCh, null, 'channel cleared');
  assert.equal(a._coviewBeat, 0, 'heartbeat cleared');
  for (const m of ['getPeers', '_setupCoView', '_coviewSend', '_coviewSendView', '_onCoMessage']) {
    assert.ok(!a.hasOwnProperty(m), `${m} removed`);
  }
  assert.equal(a.getPeers, undefined, 'duck chart has no fallback getPeers');
  assert.deepEqual(a._presence.list(), [], 'clean tracker left on the seam');
  await tick();
  assert.equal(b.getPeers().length, 0, 'peer saw the goodbye');
  assert.ok(b.events.some((e) => e.name === 'wick:peers' && e.detail.left[0]?.name === 'A'), 'left event on the peer');
  stopBeats(b);
});

/* ------------------------- component contract ------------------------- */

test('the plugin rides the documented seams, never a private copy', () => {
  const src = read('plugins/coview/coview.mjs');
  assert.match(src, /c\._coviewCh = ch/, 'channel exposed through the element seam');
  assert.match(src, /c\._presence = this\._tracker/, 'presence exposed through the element seam');
  assert.match(src, /new CustomEvent\('wick:' \+ name/, 'events are real DOM events');
  assert.ok(!src.includes("from 'wickchart'"), 'no element-module import');
  assert.ok(!src.includes('hab-'), 'no legacy alias strings');
  assert.ok(!src.includes('WickChart.prototype'), 'the prototype is never touched');
  // protocol constants come from the pure core
  assert.match(src, /CHANNEL_PREFIX/, 'channel name built from the shared prefix');
});
