/**
 * wickchart-coview/core — the pure half of cross-tab co-view: the presence
 * tracker (peer viewports with TTL expiry) and the BroadcastChannel
 * protocol envelope. No DOM, no chart, no transport — data in / data out,
 * so the room logic is testable (and reusable over WebSocket etc.) without
 * a browser.
 *
 * Until 2.0 the core element carries identical copies behind the `co-view`
 * machinery; this is the home they move into at the cut (ROADMAP-V2.md —
 * prepare additively, cut atomically). The transport itself lives in
 * coview.mjs.
 */

/** Channel names are prefixed so rooms never collide with other channels. */
export const CHANNEL_PREFIX = 'wick-co-view:';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Tracks other charts viewing the same room: last-sighting timestamps per
 * peer plus the viewport each one is looking at. Pure bookkeeping — the
 * transport (BroadcastChannel, WebSocket, …) lives in the component/app.
 *
 * Peers expire `ttl` ms after their last sighting, so a closed tab fades
 * out of the room without an explicit goodbye.
 */
export class PresenceTracker {
  /** @param {number} [ttl=12000] ms a peer survives without a sighting */
  constructor(ttl = 12000) {
    this.ttl = Math.max(1000, +ttl || 12000);
    /** @type {Map<string, {id: string, name: string|null, range: {from:number,to:number}|null, at: number}>} */
    this.peers = new Map();
  }

  /**
   * Record a sighting. `patch.range` ({from,to} times) is validated and
   * normalized; a sighting without a range keeps the previous one.
   * @returns {boolean} true when this sighting is a join (new peer)
   */
  track(id, patch = {}, now = Date.now()) {
    if (!id || typeof id !== 'string') return false;
    const existing = this.peers.get(id);
    if (existing) {
      if (patch && patch.range) {
        const f = +patch.range.from;
        const t = +patch.range.to;
        if (Number.isFinite(f) && Number.isFinite(t)) {
          existing.range = { from: Math.min(f, t), to: Math.max(f, t) };
        }
      }
      if (patch && patch.name != null) existing.name = String(patch.name).slice(0, 24) || null;
      existing.at = now;
      return false;
    }
    const f = patch && patch.range ? +patch.range.from : NaN;
    const t = patch && patch.range ? +patch.range.to : NaN;
    this.peers.set(id, {
      id,
      name: patch && patch.name != null ? (String(patch.name).slice(0, 24) || null) : null,
      range: Number.isFinite(f) && Number.isFinite(t)
        ? { from: Math.min(f, t), to: Math.max(f, t) }
        : null,
      at: now,
    });
    return true;
  }

  /** @returns {object|null} the removed peer entry, or null when unknown */
  drop(id) {
    const p = this.peers.get(id);
    this.peers.delete(id);
    return p || null;
  }

  /** Expire peers not seen within the ttl.
   *  @returns {object[]} the peer entries that left */
  sweep(now = Date.now()) {
    const left = [];
    for (const [id, p] of this.peers) {
      if (now - p.at > this.ttl) {
        this.peers.delete(id);
        left.push(p);
      }
    }
    return left;
  }

  /** @returns {{id: string, name: string|null, range: object|null, at: number}[]} copies, oldest sighting first */
  list() {
    return [...this.peers.values()]
      .sort((a, b) => a.at - b.at)
      .map((p) => ({ ...p, range: p.range ? { ...p.range } : p.range }));
  }
}

/** Wrap an outgoing message in the v1 protocol envelope. */
export function coWrap(peer, msg) {
  return { v: 1, peer, ...msg };
}

/**
 * Validate an incoming envelope. Returns the message when it is a valid
 * v1 payload from someone else, null otherwise (wrong version, missing
 * peer id, an echo of our own posts, or garbage).
 */
export function coUnwrap(m, selfId) {
  if (!m || m.v !== 1 || typeof m.peer !== 'string' || !m.peer) return null;
  if (m.peer === selfId) return null;
  return m;
}

/** A view announcement peers can render as a presence band. */
export function viewMessage(from, to, name) {
  return { type: 'view', from: +from, to: +to, name: name != null ? String(name) : null };
}

/** A pointer sighting (time + fractional y); `null` time means "left". */
export function crossMessage(time, yFrac) {
  return { type: 'cross', time: isNum(time) ? time : null, yFrac: isNum(yFrac) ? yFrac : null };
}

/** Lower-bound index for `time` in ascending bars (same rule as the chart). */
export function indexForTime(bars, time) {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
