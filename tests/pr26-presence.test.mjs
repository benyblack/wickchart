// PR #26 — co-view presence: peer viewports as bands, getPeers(), wick:peers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const { PresenceTracker } = await import('../src/core.js');
const { WickChart } = await import('../src/wick-chart.js');

const bars = (n = 50) =>
  Array.from({ length: n }, (_, i) => ({
    time: 1700000000000 + i * 3600e3,
    open: 10, high: 11, low: 9, close: 10.5, volume: 100,
  }));

/* ------------------------- PresenceTracker ------------------------- */

test('tracker: first sighting joins, re-sightings update in place', () => {
  const t = new PresenceTracker(12000);
  assert.equal(t.track('p1', { range: { from: 100, to: 50 }, name: 'maya' }), true, 'reversed range is normalized, still a join');
  assert.equal(t.track('p1', { range: { from: 60, to: 90 } }), false, 're-sight is not a join');
  const p = t.peers.get('p1');
  assert.deepEqual(p.range, { from: 60, to: 90 }, 'new viewport replaces the old one');
  const copy = t.list()[0];
  copy.range = null; // list() must hand out copies
  assert.deepEqual(t.peers.get('p1').range, { from: 60, to: 90 }, 'mutating a copy leaves the tracker intact');
});

test('tracker: invalid ranges keep the previous one; names cap at 24 chars', () => {
  const t = new PresenceTracker();
  t.track('p1', { range: { from: 10, to: 20 }, name: 'x'.repeat(60) });
  t.track('p1', { range: { from: NaN, to: 5 }, name: null });
  const p = t.peers.get('p1');
  assert.deepEqual(p.range, { from: 10, to: 20 }, 'garbage range does not clobber the last good one');
  assert.equal(p.name.length, 24);
  t.track('p1', { name: '' });
  assert.equal(t.peers.get('p1').name, null, 'empty name clears to null');
  assert.equal(t.track('', {}), false, 'empty ids are rejected');
});

test('tracker: sweep expires silent peers and reports who left', () => {
  const t = new PresenceTracker(1000);
  t.track('a', { range: { from: 1, to: 2 } }, 0);
  t.track('b', { range: { from: 3, to: 4 } }, 0);
  t.track('a', {}, 500); // a refreshes, b goes stale
  const left = t.sweep(1500);
  assert.deepEqual(left.map((p) => p.id), ['b']);
  assert.equal(t.peers.size, 1);
  assert.deepEqual(t.sweep(1500), [], 'second sweep is a no-op');
});

test('tracker: drop returns the removed entry; list is oldest-first', () => {
  const t = new PresenceTracker();
  t.track('old', {}, 100);
  t.track('new', {}, 200);
  assert.deepEqual(t.list().map((p) => p.id), ['old', 'new']);
  const gone = t.drop('old');
  assert.equal(gone.id, 'old');
  assert.equal(t.drop('ghost'), null);
});

/* ------------------------- protocol handling ------------------------- */

function fakeChart() {
  const events = [];
  return {
    events,
    invalidations: 0,
    _coviewPeer: 'me',
    _presence: new PresenceTracker(12000),
    _ghost: null,
    _ghostTimer: 0,
    _data: bars(50),
    _invalidate() { this.invalidations++; },
    _fire(name, detail) { events.push({ name, detail }); },
  };
}

const onMsg = (fake, m) => WickChart.prototype._onCoMessage.call(fake, m);

test('view message: peer joins with its viewport and fires wick:peers once', () => {
  const f = fakeChart();
  const T = (i) => f._data[i].time;
  onMsg(f, { v: 1, peer: 'p2', type: 'view', from: T(30), to: T(10), name: 'maya' });
  assert.equal(f._presence.peers.size, 1);
  const p = f._presence.peers.get('p2');
  assert.equal(p.name, 'maya');
  assert.deepEqual(p.range, { from: T(10), to: T(30) }, 'range normalized min→max');
  const joins = f.events.filter((e) => e.name === 'peers' && e.detail.joined.length);
  assert.equal(joins.length, 1);
  assert.equal(joins[0].detail.joined[0].id, 'p2');
  assert.ok(f.invalidations >= 1, 'peer arrival repaints for the band');

  onMsg(f, { v: 1, peer: 'p2', type: 'view', from: T(5), to: T(15), name: 'maya' });
  assert.equal(f.events.filter((e) => e.name === 'peers').length, 1, 'moves do not re-fire membership');
  assert.deepEqual(f._presence.peers.get('p2').range, { from: T(5), to: T(15) });
});

test('bye message: peer leaves with an event; unknown/legacy messages are ignored', () => {
  const f = fakeChart();
  onMsg(f, { v: 1, peer: 'p2', type: 'view', from: 0, to: 1, name: 'maya' });
  onMsg(f, { v: 1, peer: 'p2', type: 'bye' });
  assert.equal(f._presence.peers.size, 0);
  const left = f.events.filter((e) => e.name === 'peers' && e.detail.left.length);
  assert.equal(left.length, 1);
  assert.equal(left[0].detail.left[0].id, 'p2');

  // back-compat: legacy unknown types, wrong versions, and self-messages never throw
  onMsg(f, { v: 2, peer: 'p3', type: 'view', from: 0, to: 1 });
  onMsg(f, { v: 1, peer: 'p3', type: 'future-thing' });
  onMsg(f, { v: 1, peer: 'me', type: 'view', from: 0, to: 1 });
  onMsg(f, null);
  assert.equal(f._presence.peers.size, 0);
});

test('cross messages still drive the ghost crosshair (0.x behavior intact)', () => {
  const f = fakeChart();
  const t20 = f._data[20].time;
  onMsg(f, { v: 1, peer: 'p2', type: 'cross', time: t20, yFrac: 0.5 });
  assert.equal(f._ghost.index, 20);
  assert.equal(f._ghost.yFrac, 0.5);
  clearTimeout(f._ghostTimer);
  onMsg(f, { v: 1, peer: 'p2', type: 'cross', time: null, yFrac: null });
  assert.equal(f._ghost, null, 'pointer-leave clears the ghost');
});

/* ------------------------- component contract ------------------------- */

test('presence is wired into the chart: attribute, heartbeat, broadcast, bands', () => {
  const src = read('src/wick-chart.js');
  assert.match(src, /'co-view-name'/, 'co-view-name is an observed attribute');
  assert.match(src, /case 'co-view-name':/, 'attribute handler exists');
  const setup = src.slice(src.indexOf('_setupCoView() {'), src.indexOf('_coviewSendView(force)'));
  assert.match(setup, /_coviewSendView\(true\)/, 'announce immediately on join');
  assert.match(setup, /setInterval/, 'heartbeat keeps presence warm');
  assert.match(setup, /4000\)/, 'heartbeat every 4s');
  assert.match(setup, /_presence\.sweep\(\)/, 'stale peers are swept');
  assert.match(src, /_emitRange\(\) \{[\s\S]*?_coviewSendView\(\)/, 'pan/zoom broadcasts the viewport');
  assert.match(src, /getPeers\(\) \{/);
  assert.match(src, /this\._coviewSend\(\{ type: 'bye' \}\)/, 'disconnect says goodbye');
  const bands = src.slice(src.indexOf('co-view presence: peer viewport bands'), src.indexOf('co-view ghost crosshair'));
  assert.ok(bands.length > 300, 'band drawing block present');
  assert.match(bands, /pal\.overlay/, 'band colors come from the theme palette');
  assert.match(bands, /fillRect/, 'bands are drawn as rects');
  assert.match(bands, /p\.name \|\| p\.id/, 'bands label peers by name or id');
});

test('the plugins hub covers co-view presence: API, event, attribute, transport note', () => {
  const hub = read('plugins.html');
  const sec = hub.slice(hub.indexOf('id="coview"'), hub.indexOf('id="scenario"'));
  assert.ok(sec.length > 1200, 'coview coverage is substantive');
  for (const s of ['getPeers', 'wick:peers', 'co-view-name', 'co-view', 'BroadcastChannel', 'wick:range', 'joined', 'left']) {
    assert.ok(sec.includes(s), `"${s}" missing from the hub coview section`);
  }
  assert.ok(hub.includes('href="#coview"'), 'hub TOC links the section');
  assert.ok(read('README.md').includes('getPeers()'), 'README mentions getPeers()');
});
