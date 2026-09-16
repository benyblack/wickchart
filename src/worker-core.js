/* ==========================================================================
 * worker-core — the worker side of the worker compute path.
 *
 * Runs inside a module Worker spawned by src/worker.js. Tasks arrive with a
 * correlation id; replies carry { id, ok, ... }. The chart sends its dataset
 * once per data epoch as six Float64Arrays (transferred, not cloned — a
 * structured clone of a million bar objects costs ~1 s, the columnar fill
 * ~25 ms), and indicator tasks afterwards reference that data by
 * (sid, epoch). Sessions are keyed per chart so one shared worker can serve
 * several charts; the two most recent are kept (1M bars of columns plus the
 * rebuilt object tape is ~50 MB each).
 *
 * handle() is exported (and pure with respect to its state object) so the
 * dispatch is unit-testable in Node with no Worker at all.
 * ========================================================================== */

import { BUILTIN_INDICATORS } from './core.js';

/** Rebuild the bar-object tape from a columnar snapshot (worker-side only —
 *  this cost never touches the main thread). */
export function barsFromCols(cols) {
  const n = cols.time.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      time: cols.time[i],
      open: cols.open[i],
      high: cols.high[i],
      low: cols.low[i],
      close: cols.close[i],
      volume: cols.volume[i],
    };
  }
  return out;
}

/**
 * Create a worker-core state + dispatcher.
 * @returns {{sessions: Map, handle(message: object): object}} the reply object
 */
export function createWorkerCore() {
  const sessions = new Map(); // sid → { epoch, cols, bars: Array|null }
  return {
    sessions,

    handle(msg) {
      const { id, type, sid } = msg || {};
      if (type === 'epoch') {
        // keep at most two chart sessions resident
        while (sessions.size >= 2) sessions.delete(sessions.keys().next().value);
        sessions.set(sid, { epoch: msg.epoch, cols: msg.cols, bars: null });
        return { id, ok: true };
      }
      if (type === 'indicator') {
        const s = sessions.get(sid);
        if (!s || s.epoch !== msg.epoch) {
          // the worker no longer holds this epoch's data (evicted, or the
          // chart is ahead) — the chart resends and retries
          return { id, ok: false, stale: true };
        }
        const def = BUILTIN_INDICATORS.get(msg.name);
        if (!def) return { id, ok: false, error: 'unknown indicator: ' + msg.name };
        let res = null;
        try {
          if (!s.bars) s.bars = barsFromCols(s.cols); // once per epoch
          res = def.compute(s.bars, msg.params || {});
        } catch (_) {
          res = null; // same contract as the sync path: a failed compute draws nothing
        }
        return { id, ok: true, res };
      }
      return { id, ok: false, error: 'unknown task type: ' + type };
    },
  };
}

/* ---------------- worker bootstrap (real Worker scope only) ---------------- */

const inWorker =
  typeof WorkerGlobalScope !== 'undefined' &&
  typeof self !== 'undefined' &&
  self instanceof WorkerGlobalScope;

if (inWorker) {
  const core = createWorkerCore();
  self.onmessage = (e) => {
    self.postMessage(core.handle(e.data));
  };
}
