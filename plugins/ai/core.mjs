/**
 * wickchart-ai/core — the pure agent surface: the tool manifest
 * (AI_TOOLS), the system prompt builder (aiPromptText) and the validated
 * op dispatcher (applyChartOps). No DOM, no network — LLM output is
 * untrusted input, so every op is whitelisted and validated before it
 * touches the chart, and a failing op reports {ok:false} instead of
 * throwing so an agent can self-correct.
 *
 * Owned here since the 2.0 cut (they left the core entry); the shared
 * validators it composes (parseIndicators, normalizeOverlays) stay in
 * wickchart/core, where the element itself uses them.
 */

import { parseIndicators, normalizeOverlays, toMs, SERIES_TYPES } from 'wickchart/core';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const AI_CHART_TYPES = SERIES_TYPES;

/**
 * Tool manifest for LLM/agent control of a chart. Tools map 1:1 onto the
 * public element API; every op through applyChartOps is validated before it
 * touches the chart (LLM output is untrusted input).
 */
export const AI_TOOLS = [
  {
    tool: 'get_data_window',
    description:
      'Read the visible chart window: OHLC stats, trend (slope + fit), volatility percentile, indicator snapshots, detected patterns. Returns structured fields plus a markdown summary.',
    args: {},
  },
  {
    tool: 'set_indicators',
    description:
      'Replace the indicators. Tokens: sma:20 ema:50 bb:20 vwap supertrend:10/3 donchian:20 keltner:20 rsi:14 macd:12/26/9 stoch:14/3 atr:14 obv cci:20 wr:14 volume, @hexcolor suffixes, or WickScript expressions like expr:{close - sma(close,20)} / pexpr:{rsi(close,14)}. Empty string clears all.',
    args: { indicators: 'string — space/comma-separated tokens' },
  },
  {
    tool: 'set_overlays',
    description:
      'Draw zones & levels behind the candles (support/resistance, supply/demand). Zone: {type:"zone", from?, to?, priceFrom, priceTo, color?, alpha?, label?} — omit `to` (or pass null) to extend into future space past the last bar. Level: {type:"level", price, color?, dash?, label?}. Invalid entries are dropped.',
    args: { overlays: 'array of overlay objects' },
  },
  { tool: 'clear_overlays', description: 'Remove all overlays.', args: {} },
  {
    tool: 'add_alert',
    description:
      'Price alert {price, direction:"above"|"below"|"cross"} or scripted predicate {when:"<WickScript>"} — e.g. when:"crossup(rsi(close,14), 30)" or when:"volume > sma(volume,20) * 3". Fires wick:alert.',
    args: {},
  },
  {
    tool: 'set_view',
    description: 'Set the visible time range (unix seconds or ms).',
    args: { from: 'timestamp', to: 'timestamp' },
  },
  { tool: 'reset_view', description: 'Fit all loaded data.', args: {} },
  {
    tool: 'set_type',
    description: 'Change the series type.',
    args: { type: '"candles" | "line" | "area" | "bars" | "hollow" | "heikin"' },
  },
  {
    tool: 'set_volshading',
    description: 'Volatility-regime background shading (calm/normal/hot percentiles).',
    args: { enabled: 'boolean', low: 'percentile 0–98 (default 30)', high: 'percentile (default 70)' },
  },
];

/**
 * Compact system prompt for agent control: paste into any LLM alongside the
 * tool manifest. The model answers with a JSON array of {tool, args} ops.
 * @returns {string}
 */
export function aiPromptText() {
  const lines = AI_TOOLS.map(
    (t) => `- ${t.tool}${Object.keys(t.args).length ? '(' + Object.keys(t.args).join(', ') + ')' : '()'}: ${t.description}`
  );
  return [
    'You are controlling a WickChart financial charting element through tool calls.',
    'Reply with ONLY a JSON array of operations to apply, each {"tool": name, "args": {...}}.',
    'Use get_data_window first when you need to see the chart before deciding.',
    'Available tools:',
    ...lines,
  ].join('\n');
}

/**
 * Validate + apply a list of {tool, args} ops (typically LLM output) to a
 * chart-like target. Ops are whitelisted and their args validated — an op
 * never throws; it returns { ok: false, error } instead so the agent can
 * self-correct. Target contract: getDataWindow(), setAttribute(k, v),
 * setOverlays(list), clearOverlays(), addAlert(a), setVisibleRange(r),
 * fit(), and (static) _registry() for indicator name checks.
 * @param {object} target chart element (or test double)
 * @param {any} ops
 * @returns {Array<{ok: boolean, tool?: string, result?: any, error?: string}>}
 */
export function applyChartOps(target, ops) {
  if (!target) return [{ ok: false, error: 'no target' }];
  if (!Array.isArray(ops)) return [{ ok: false, error: 'ops must be an array of {tool, args} objects' }];
  return ops.map((op) => {
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      return { ok: false, error: 'each op must be an object: {tool, args}' };
    }
    const tool = String(op.tool || '');
    const args = op.args && typeof op.args === 'object' && !Array.isArray(op.args) ? op.args : {};
    const fail = (error) => ({ ok: false, tool, error });
    try {
      switch (tool) {
        case 'get_data_window':
          return { ok: true, tool, result: target.getDataWindow() };
        case 'set_indicators': {
          if (typeof args.indicators !== 'string') return fail('args.indicators must be a string');
          const reg = target.constructor && target.constructor._registry ? target.constructor._registry() : null;
          const parsed = parseIndicators(args.indicators, reg);
          if (parsed.unknown.length) {
            return fail(`unknown indicators: ${parsed.unknown.join(', ')}`);
          }
          target.setAttribute('indicators', args.indicators);
          return { ok: true, tool, result: { applied: args.indicators || '(cleared)' } };
        }
        case 'set_overlays': {
          if (!Array.isArray(args.overlays)) return fail('args.overlays must be an array');
          const norm = normalizeOverlays(args.overlays);
          if (!norm.length) return fail('no valid overlays in args.overlays');
          const ids = target.setOverlays(args.overlays);
          return { ok: true, tool, result: { applied: ids.length, dropped: args.overlays.length - ids.length } };
        }
        case 'clear_overlays':
          target.clearOverlays();
          return { ok: true, tool, result: { cleared: true } };
        case 'add_alert': {
          if (!isNum(args.price) && typeof args.when !== 'string') {
            return fail('args needs either price (number) or when (WickScript string)');
          }
          const id = target.addAlert(args);
          return id ? { ok: true, tool, result: { id } } : fail('invalid alert (bad predicate?)');
        }
        case 'set_view': {
          const r = {};
          if (isNum(args.from)) r.from = toMs(args.from);
          if (isNum(args.to)) r.to = toMs(args.to);
          if (!('from' in r) && !('to' in r)) return fail('args needs from and/or to timestamps');
          target.setVisibleRange(r);
          return { ok: true, tool, result: r };
        }
        case 'reset_view':
          target.fit();
          return { ok: true, tool, result: { reset: true } };
        case 'set_type': {
          if (!AI_CHART_TYPES.includes(args.type)) {
            return fail(`args.type must be one of ${AI_CHART_TYPES.join(' | ')}`);
          }
          target.setAttribute('type', args.type);
          return { ok: true, tool, result: { type: args.type } };
        }
        case 'set_volshading': {
          if (args.enabled === false) {
            target.setAttribute('volshading', 'false');
            return { ok: true, tool, result: { enabled: false } };
          }
          const lo = Math.round(clamp(+args.low || 30, 0, 98));
          const hi = Math.round(clamp(+args.high || 70, lo + 2, 99));
          target.setAttribute('volshading', `${lo}/${hi}`);
          return { ok: true, tool, result: { low: lo, high: hi } };
        }
        default:
          return fail(`unknown tool: ${tool}`);
      }
    } catch (err) {
      return fail(err && err.message ? err.message : String(err));
    }
  });
}
