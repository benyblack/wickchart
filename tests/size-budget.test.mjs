// Bundle-size budget — keeps "zero-dependency and small" an enforced invariant
// instead of an intention. Covers the main entry only (core.js + wick-chart.js):
// feeds/react entries are separate opt-in imports with their own profile.
//
// If this fails because of an intentional addition, raise BUDGET_GZ in its own
// commit and say why in the message — the diff IS the budget conversation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

// 64→68 KB: the indicators batch (vwap/atr/stoch/obv/supertrend/donchian/
// keltner/cci/wr) landed at 64.3 KB gz — still zero-dependency, still small.
//
// 68→72 KB: timezone-aware axis labels + a VWAP session anchor. The correctness
// pass before this took the entry to 67.26 KB, leaving 0.74 KB — not enough for
// DST-exact Intl offset math, and shaving comments to squeeze a feature in is
// how a budget stops meaning anything.
//
// 72→74 KB: the worker compute path (PR #64). The indicator offload has to
// live at the _indicatorSeries chokepoint in the main entry (+1.66 KB: the
// eligibility branch, the epoch/pending bookkeeping and the columnar
// snapshot); the worker itself is opt-in 'wickchart/worker' bytes outside
// this budget. Landed at 72.46 KB.
//
// This is a ceiling raise, not a licence to sprawl. The reclaim is already
// measured and deliberately deferred to 2.0, where the plugin split moves
// sonification (1.11), narrator (1.26), story (1.60), co-view (1.79),
// scenario/risk (1.86) and the AI helpers (2.01) out of the core — ~9.6 KB,
// targeting an entry back under 62 KB. Extracting them now would break
// chart.narrate() / playStory() / playRange() / getPeers() and the sonify and
// co-view attributes, which is a major-version conversation, not a budget one.
//
// 74→75 KB: the 1.7.1 deprecation warnings for the 0.x hab-* aliases
// (warn-once helper + five alias sites; PR #75). Temporary by construction —
// the 2.0 cut deletes every alias site these warnings ride on. Landed at
// 74.17 KB.
const BUDGET_GZ = 75 * 1024; // 75 KB gzipped for the whole main entry
const FILES = ['src/core.js', 'src/wick-chart.js'];

// the drawing toolkit is opt-in bytes; it earns its own, smaller budget
const DRAW_BUDGET_GZ = 12 * 1024;
const DRAW_FILES = ['plugins/draw/core.mjs', 'plugins/draw/draw.mjs'];

// session shading is even smaller opt-in bytes (its own budget, same rule):
// landed at 6.3 KB gz — timezone math (DST-exact presets), bands, labels and
// the crosshair hover bridge included.
const SESSIONS_BUDGET_GZ = 7 * 1024;
const SESSIONS_FILES = ['plugins/sessions/core.mjs', 'plugins/sessions/sessions.mjs'];

// bar replay is a single-file plugin (state machine + badge layer), same rule
const REPLAY_BUDGET_GZ = 5 * 1024;
const REPLAY_FILES = ['plugins/replay/replay.mjs'];

// compare overlays: normalization + alignment math + the drawing layer
const COMPARE_BUDGET_GZ = 6 * 1024;
const COMPARE_FILES = ['plugins/compare/core.mjs', 'plugins/compare/compare.mjs'];

// navigator: profile downsampling + window drag math + the docked layer
const NAVIGATOR_BUDGET_GZ = 5 * 1024;
const NAVIGATOR_FILES = ['plugins/navigator/core.mjs', 'plugins/navigator/navigator.mjs'];

// alerts-plus: persistence + notification/webhook side channels, single file
const ALERTS_PLUS_BUDGET_GZ = 4 * 1024;
const ALERTS_PLUS_FILES = ['plugins/alerts-plus/alerts-plus.mjs'];

// layouts: named workspace persistence, single file
const LAYOUTS_BUDGET_GZ = 4 * 1024;
const LAYOUTS_FILES = ['plugins/layouts/layouts.mjs'];

// signals: pattern math + the badge layer
const SIGNALS_BUDGET_GZ = 5 * 1024;
const SIGNALS_FILES = ['plugins/signals/core.mjs', 'plugins/signals/signals.mjs'];

// tape: print normalization + tick rule + trades→bars + the docked strip
// (landed at 4.6 KB gz — display-only layer, no pointer machinery)
const TAPE_BUDGET_GZ = 6 * 1024;
const TAPE_FILES = ['plugins/tape/core.mjs', 'plugins/tape/tape.mjs'];

// grid: multi-chart sync fan-out (echo + clamp-cycle guards) + the element
// (landed at 4.4 KB gz — pure event plumbing, no drawing beyond ghost lines)
const GRID_BUDGET_GZ = 5 * 1024;
const GRID_FILES = ['plugins/grid/core.mjs', 'plugins/grid/grid.mjs'];

// paper: fills/netting/fees engine + replay wiring + the equity strip
// (landed at 6.2 KB gz — engine is pure, the strip is a docked layer)
const PAPER_BUDGET_GZ = 7 * 1024;
const PAPER_FILES = ['plugins/paper/core.mjs', 'plugins/paper/paper.mjs'];

// narrator: the guided-playback family (timeline analyzer + walk + story +
// sonify) as one package. Standalone it measures larger than the ~3.9 KB
// the same code costs inside the main entry's gzip context — the analyzer
// primitives stay in wickchart/core (shared with the annotations overlay),
// so only the playback machinery lives here. Landed at 8.6 KB gz.
const NARRATOR_BUDGET_GZ = 9 * 1024;
const NARRATOR_FILES = ['plugins/narrator/core.mjs', 'plugins/narrator/narrator.mjs'];

// coview: cross-tab co-view (presence tracker + BroadcastChannel protocol +
// the attach layer driving the element's band/ghost seams). Self-contained —
// imports nothing from wickchart. Landed at 5.0 KB gz.
const COVIEW_BUDGET_GZ = 6 * 1024;
const COVIEW_FILES = ['plugins/coview/core.mjs', 'plugins/coview/coview.mjs'];

// scenario: planning setters (path/cone projection + R-multiple risk plan)
// driving the element's state seams. Measures small on purpose during 1.x —
// core.mjs re-exports the validators/cone math from wickchart/core (shared
// with the AI window and narrator's scene validation); at the 2.0 cut those
// functions move in here and the budget grows accordingly. Landed at 2.1 KB.
const SCENARIO_BUDGET_GZ = 3 * 1024;
const SCENARIO_FILES = ['plugins/scenario/core.mjs', 'plugins/scenario/scenario.mjs'];

// ai: the agent surface (tool manifest + prompt + validated dispatcher,
// installed as five instance methods). Same 1.x story as scenario — the
// manifest/prompt/dispatcher re-export from wickchart/core and move in at
// the 2.0 cut. Landed at 2.2 KB gz.
const AI_BUDGET_GZ = 3 * 1024;
const AI_FILES = ['plugins/ai/core.mjs', 'plugins/ai/ai.mjs'];

// The gzip budgets measure canonical content: CRLF is a checkout artifact
// (core.autocrlf on Windows), not bytes anyone ships — the registry and CI
// both normalize to LF, so the test does too before measuring.
const readLf = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const gz = (f) => gzipSync(Buffer.from(readLf(f), 'utf8')).length;

test('main entry stays under the gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= BUDGET_GZ,
    `main entry is ${(total / 1024).toFixed(1)} KB gz, budget is ${BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}\n` +
      'If this growth is intentional, raise BUDGET_GZ in tests/size-budget.test.mjs in a dedicated commit explaining why.'
  );
});

test('wickchart-draw plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of DRAW_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= DRAW_BUDGET_GZ,
    `wickchart-draw is ${(total / 1024).toFixed(1)} KB gz, budget is ${DRAW_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});

test('wickchart-sessions plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of SESSIONS_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= SESSIONS_BUDGET_GZ,
    `wickchart-sessions is ${(total / 1024).toFixed(1)} KB gz, budget is ${SESSIONS_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});

test('wickchart-replay plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of REPLAY_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= REPLAY_BUDGET_GZ,
    `wickchart-replay is ${(total / 1024).toFixed(1)} KB gz, budget is ${REPLAY_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});

test('wickchart-compare plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of COMPARE_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= COMPARE_BUDGET_GZ,
    `wickchart-compare is ${(total / 1024).toFixed(1)} KB gz, budget is ${COMPARE_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});

test('wickchart-navigator plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of NAVIGATOR_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= NAVIGATOR_BUDGET_GZ,
    `wickchart-navigator is ${(total / 1024).toFixed(1)} KB gz, budget is ${NAVIGATOR_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});

test('wickchart-alerts-plus plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of ALERTS_PLUS_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= ALERTS_PLUS_BUDGET_GZ,
    `wickchart-alerts-plus is ${(total / 1024).toFixed(1)} KB gz, budget is ${ALERTS_PLUS_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});

test('wickchart-layouts plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of LAYOUTS_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= LAYOUTS_BUDGET_GZ,
    `wickchart-layouts is ${(total / 1024).toFixed(1)} KB gz, budget is ${LAYOUTS_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});

test('wickchart-signals plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of SIGNALS_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= SIGNALS_BUDGET_GZ,
    `wickchart-signals is ${(total / 1024).toFixed(1)} KB gz, budget is ${SIGNALS_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});

test('wickchart-tape plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of TAPE_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= TAPE_BUDGET_GZ,
    `wickchart-tape is ${(total / 1024).toFixed(1)} KB gz, budget is ${TAPE_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});

test('wickchart-grid plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of GRID_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= GRID_BUDGET_GZ,
    `wickchart-grid is ${(total / 1024).toFixed(1)} KB gz, budget is ${GRID_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});

test('wickchart-paper plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of PAPER_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= PAPER_BUDGET_GZ,
    `wickchart-paper is ${(total / 1024).toFixed(1)} KB gz, budget is ${PAPER_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});

test('wickchart-narrator plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of NARRATOR_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= NARRATOR_BUDGET_GZ,
    `wickchart-narrator is ${(total / 1024).toFixed(1)} KB gz, budget is ${NARRATOR_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});

test('wickchart-coview plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of COVIEW_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= COVIEW_BUDGET_GZ,
    `wickchart-coview is ${(total / 1024).toFixed(1)} KB gz, budget is ${COVIEW_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});

test('wickchart-scenario plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of SCENARIO_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= SCENARIO_BUDGET_GZ,
    `wickchart-scenario is ${(total / 1024).toFixed(1)} KB gz, budget is ${SCENARIO_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});

test('wickchart-ai plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of AI_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= AI_BUDGET_GZ,
    `wickchart-ai is ${(total / 1024).toFixed(1)} KB gz, budget is ${AI_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});
