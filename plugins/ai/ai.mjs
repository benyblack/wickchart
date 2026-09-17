/**
 * wickchart-ai — the chart as an LLM tool surface, as a plugin: a tool
 * manifest, a system prompt, grounding context and a validated op
 * dispatcher. The chart itself never touches the network — you bring the
 * model (`run`), the plugin builds the payload and applies the answer.
 *
 *   import { attachAI } from 'wickchart-ai';
 *
 *   const ai = attachAI(chart);
 *   const { payload } = await chart.ask('add RSI and mark the demand zone');
 *   // send payload anywhere, then:
 *   chart.applyAI([{ tool: 'set_indicators', args: { indicators: 'rsi:14' } }]);
 *   // or hand the call straight through:
 *   const { results } = await chart.ask('switch to a line chart', {
 *     run: async (p) => (await callMyLLM(p)).ops,
 *   });
 *   ai.detach();
 *
 * Calls keep their core shape — the familiar methods are installed on the
 * instance, so code written against chart.ask() / applyAI() works with one
 * added import. Until 2.0 the core element ships its own identical
 * methods; attaching shadows them (see ROADMAP-V2.md).
 *
 * getDataWindow() stays in core by design: it is a data API (and the
 * demo's Explain button), not an LLM API — ask()/aiContext() compose it
 * from here.
 */

import { AI_TOOLS, aiPromptText, applyChartOps } from './core.mjs';

export { AI_TOOLS, aiPromptText, applyChartOps } from './core.mjs';

const INSTALLED = ['aiTools', 'aiPrompt', 'aiContext', 'applyAI', 'ask'];

export function attachAI(chart) {
  return new AI(chart);
}

export class AI {
  /**
   * @param {object} chart a <wick-chart> (or anything with its state /
   *   data-window / op surface) to install the agent methods on
   */
  constructor(chart) {
    if (
      !chart ||
      typeof chart.getState !== 'function' ||
      typeof chart.getDataWindow !== 'function' ||
      typeof chart.dispatchEvent !== 'function'
    ) {
      throw new TypeError('attachAI(chart): the chart element is required');
    }
    if (chart._wickAI) return chart._wickAI; // idempotent attach
    this._chart = chart;
    for (const m of INSTALLED) chart[m] = this[m].bind(this);
    chart._wickAI = this;
  }

  detach() {
    const c = this._chart;
    if (!c) return;
    for (const m of INSTALLED) {
      try {
        delete c[m];
      } catch (_) {}
    }
    try {
      delete c._wickAI;
    } catch (_) {}
    this._chart = null;
  }

  /** Tool manifest for LLM control — JSON-safe copy of AI_TOOLS. */
  aiTools() {
    return JSON.parse(JSON.stringify(AI_TOOLS));
  }

  /** System prompt for agent control — paste into any LLM alongside aiTools(). */
  aiPrompt() {
    return aiPromptText();
  }

  /** Grounding context for a model: current state + visible-window summary. */
  aiContext() {
    const c = this._chart;
    if (!c) return { state: null, window: null };
    return { state: c.getState(), window: c.getDataWindow() };
  }

  /**
   * Apply a list of {tool, args} ops (typically LLM output) through the
   * validated dispatcher. Never throws — each op resolves {ok, tool,
   * result} or {ok: false, tool, error} so an agent can self-correct.
   * @param {any} ops
   * @returns {Array<object>}
   */
  applyAI(ops) {
    const c = this._chart;
    return c ? applyChartOps(c, ops) : [{ ok: false, error: 'detached' }];
  }

  /**
   * Ask an AI to operate the chart. Builds the payload {system,
   * instruction, chart, tools}; with a `run` async function (your model
   * call — the chart itself never touches the network), applies the
   * returned ops and resolves {payload, ops, results}. Without `run`,
   * returns the payload for manual wiring — send it anywhere, then call
   * chart.applyAI(ops) with the model's answer.
   *
   *   const { results } = await chart.ask('add RSI and mark the demand zone', {
   *     run: async (payload) => (await callMyLLM(payload)).ops,
   *   });
   *
   * @param {string} instruction natural-language request
   * @param {{run?: (payload: object) => Promise<any>}} [opts]
   */
  async ask(instruction, opts = {}) {
    const payload = {
      system: aiPromptText(),
      instruction: String(instruction == null ? '' : instruction),
      chart: this.aiContext(),
      tools: this.aiTools(),
    };
    if (typeof opts.run !== 'function') {
      return { payload, ops: null, results: null };
    }
    const ops = await opts.run(payload);
    const results = this.applyAI(ops);
    return { payload, ops, results };
  }
}
