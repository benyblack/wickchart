/* ==========================================================================
 * <wick-chart> worker compute path — the main-thread side.
 *
 *   import 'wickchart/worker';            // once, anywhere
 *   <wick-chart worker indicators="sma:20 bb:20 rsi:14"></wick-chart>
 *
 * Importing this module wires a shared ChartWorkerPool into the chart class;
 * from then on, any chart with the `worker` attribute computes its built-in
 * indicators off the main thread once the dataset crosses WORKER_MIN_BARS
 * (50k bars). Custom/scripted indicators are closures and stay sync; so does
 * everything below the threshold. Data crosses once per bulk load as six
 * transferable Float64Arrays — never as cloned objects.
 *
 *   import { ChartWorkerPool, getSharedPool, setChartWorkerPool } from 'wickchart/worker';
 *   const pool = new ChartWorkerPool();   // a private pool (e.g. one per tab view)
 *   setChartWorkerPool(pool);
 *
 * No Worker available (old browsers, non-HTTP contexts where module workers
 * fail, Node)? pool.available is false and every chart silently stays on the
 * synchronous path — the attribute is an optimization, never a dependency.
 * ========================================================================== */

import { WickChart } from './wick-chart.js';

export { WickChart };

/**
 * A single-Worker task runner. The factory is injectable so tests can drive
 * the protocol with a fake Worker; the default spawns the module worker
 * sitting next to this file.
 */
export class ChartWorkerPool {
  /** @param {() => Worker} [factory] */
  constructor(factory) {
    this._factory =
      typeof factory === 'function'
        ? factory
        : typeof Worker === 'function'
          ? () => new Worker(new URL('./worker-core.js', import.meta.url), { type: 'module' })
          : null;
    this.available = this._factory != null;
    this._worker = null;
    this._seq = 0;
    this._pending = new Map(); // id → { resolve, reject }
  }

  /**
   * Post a task; resolves with the reply's `res`, rejects on failure or
   * worker death (a `stale` rejection means: resend the epoch data first).
   * @param {object} msg task message without the id
   * @returns {Promise<any>}
   */
  run(msg) {
    if (!this.available) return Promise.reject(new Error('worker unavailable'));
    if (!this._worker) this._spawn();
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try {
        this._worker.postMessage({ ...msg, id });
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  _spawn() {
    try {
      this._worker = this._factory();
    } catch (err) {
      this.available = false;
      throw err;
    }
    this._worker.onmessage = (e) => {
      const reply = e.data || {};
      const p = this._pending.get(reply.id);
      if (!p) return;
      this._pending.delete(reply.id);
      if (reply.stale) p.reject(Object.assign(new Error('stale epoch'), { stale: true }));
      else if (reply.ok) p.resolve(reply.res);
      else p.reject(new Error(reply.error || 'worker task failed'));
    };
    this._worker.onerror = () => this._die();
    this._worker.onmessageerror = () => this._die();
  }

  /** Reject everything in flight and drop the worker; the next run() respawns
   *  — a transient worker crash must not permanently kill the mode. */
  _die() {
    for (const p of this._pending.values()) p.reject(new Error('worker died'));
    this._pending.clear();
    if (this._worker) {
      try {
        this._worker.terminate();
      } catch (_) {}
    }
    this._worker = null;
  }

  /** Shut the pool down for good (in-flight tasks reject). */
  terminate() {
    this._die();
    this.available = false;
  }
}

let shared = null;

/** The page-wide pool (created on first use). */
export function getSharedPool() {
  return shared || (shared = new ChartWorkerPool());
}

/**
 * Point the chart class at a pool (or null to disable the worker path).
 * @param {ChartWorkerPool|null} pool
 */
export function setChartWorkerPool(pool) {
  WickChart._workerPool = pool;
  return pool;
}

// importing 'wickchart/worker' is the whole setup: wire the shared pool into
// the chart class so <wick-chart worker> just works afterwards
if (typeof Worker === 'function') {
  setChartWorkerPool(getSharedPool());
}
