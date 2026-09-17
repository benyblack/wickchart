// wickchart-coview — the pure core: presence tracking with TTL expiry and
// the protocol envelope. Mirrors the pr26 behavior the core copy carries,
// and holds the copies to parity while both exist (until the 2.0 cut —
// ROADMAP-V2.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PresenceTracker,
  CHANNEL_PREFIX,
  coWrap,
  coUnwrap,
  viewMessage,
  crossMessage,
  indexForTime,
} from '../core.mjs';

const read = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');

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

/* ------------------------- protocol envelope ------------------------- */

test('coWrap/coUnwrap: the v1 envelope, and everything it rejects', () => {
  const msg = coWrap('p1', viewMessage(100, 200, 'maya'));
  assert.deepEqual(msg, { v: 1, peer: 'p1', type: 'view', from: 100, to: 200, name: 'maya' });
  assert.equal(coUnwrap(msg, 'p2'), msg, 'valid peer message passes through');
  assert.equal(coUnwrap(msg, 'p1'), null, 'own echo is rejected');
  assert.equal(coUnwrap({ v: 2, peer: 'p9', type: 'view' }, 'p1'), null, 'wrong version');
  assert.equal(coUnwrap({ v: 1, peer: '', type: 'view' }, 'p1'), null, 'empty peer id');
  assert.equal(coUnwrap({ v: 1 }, 'p1'), null, 'missing peer id');
  assert.equal(coUnwrap(null, 'p1'), null, 'null envelope');
  assert.equal(coUnwrap('hello', 'p1'), null, 'garbage');
});

test('message builders: view carries the window, cross sanitizes its payload', () => {
  assert.deepEqual(viewMessage(100, 50, 'maya'), { type: 'view', from: 100, to: 50, name: 'maya' });
  assert.equal(viewMessage(1, 2, 7).name, '7', 'names coerce to string');
  assert.deepEqual(crossMessage(1700000000000, 0.5), { type: 'cross', time: 1700000000000, yFrac: 0.5 });
  assert.deepEqual(crossMessage(null, null), { type: 'cross', time: null, yFrac: null }, 'leave message');
  assert.deepEqual(crossMessage('x', 'y'), { type: 'cross', time: null, yFrac: null }, 'garbage becomes leave');
  assert.deepEqual(crossMessage(5, 9), { type: 'cross', time: 5, yFrac: 9 }, 'numeric payloads pass (clamped later)');
});

test('indexForTime: lower-bound mapping like the chart', () => {
  const bars = Array.from({ length: 10 }, (_, i) => ({ time: 1000 + i * 10 }));
  assert.equal(indexForTime(bars, 1000), 0);
  assert.equal(indexForTime(bars, 1005), 1, 'between bars rounds up');
  assert.equal(indexForTime(bars, 9999), 9, 'past the end clamps');
});

/* ------------------------- component contract ------------------------- */

test('the pure core is self-contained — no wickchart imports', () => {
  const src = read('plugins/coview/core.mjs');
  assert.ok(!/^import /m.test(src), 'core.mjs imports nothing (transport-agnostic)');
  assert.match(src, /wick-co-view:/, 'channel prefix has no hab- history');
  assert.ok(!src.includes('hab-'), 'no legacy alias strings');
});
