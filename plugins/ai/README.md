# wickchart-ai

[![npm](https://img.shields.io/npm/v/wickchart-ai)](https://www.npmjs.com/package/wickchart-ai)

The [wickchart](https://github.com/benyblack/wickchart) chart as an LLM
tool surface, as an opt-in plugin — everything an agent needs to read and
operate a chart, and nothing that touches the network:

- **`aiTools()`** — a self-describing tool manifest (JSON-safe)
- **`aiPrompt()`** — the matching system prompt: reply with a JSON array
  of `{tool, args}` ops
- **`aiContext()`** — grounding: the serialized chart state plus the
  visible-window summary (trend, volatility percentile, indicator
  snapshots, detected patterns)
- **`applyAI(ops)`** — the validated dispatcher: ops are whitelisted and
  their args checked; LLM output is untrusted input, so an op never
  throws — it resolves `{ok: false, error}` so the agent can self-correct
- **`ask(instruction, {run})`** — builds the payload, calls your `run`
  (your model call), applies the returned ops

```js
npm install wickchart wickchart-ai

import 'wickchart';
import { attachAI } from 'wickchart-ai';

const ai = attachAI(chart);

// fully wired — your model, your keys:
const { results } = await chart.ask('add RSI and mark the demand zone', {
  run: async (payload) => (await callMyLLM(payload)).ops,
});

// or two-step, manual transport:
const { payload } = await chart.ask('switch to a line chart');
// …send payload.system + payload.tools + payload.instruction + payload.chart
const results2 = chart.applyAI([
  { tool: 'set_type', args: { type: 'line' } },
  { tool: 'set_indicators', args: { indicators: 'sma:20 ema:50' } },
]);

ai.detach();
```

Attaching installs the familiar methods **on the instance**, so code
written against `chart.ask()` / `applyAI()` keeps its shape. Until
wickchart 2.0 the core element ships its own identical methods; attaching
shadows them (this package is the home they move into at the cut — see
`ROADMAP-V2.md` in the repo).

## The tools

`get_data_window`, `set_indicators`, `set_overlays`, `clear_overlays`,
`add_alert` (price or WickScript predicate), `set_view`, `reset_view`,
`set_type`, `set_volshading`. The manifest describes each one with its
args — feed `aiPrompt()` + `aiTools()` to any model (or MCP server) and
it has everything it needs.

`getDataWindow()` itself stays in core by design: it is a data API (and
the demo's Explain button), not an LLM API — `ask()`/`aiContext()`
compose it from here.

## Notes

- The chart never touches the network — `run` is yours, so keys and
  endpoints stay in your code.
- Per-op results come back in order; one bad op never poisons the batch.
- The pure surface (manifest, prompt, dispatcher) is a separate import:
  `wickchart-ai/core`. During 1.x it re-exports the functions from
  `wickchart/core` unchanged — identity is asserted in the tests — and
  they settle into this package at the 2.0 cut.

MIT.
