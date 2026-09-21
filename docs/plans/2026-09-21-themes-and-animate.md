# Themes (`registerTheme`) + `plugins/animate` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `registerTheme()` (named custom themes in core, ~0.5 KB gz) and `plugins/animate` (opt-in live-price easing plugin, zero core bytes) per [the approved design](./2026-09-21-themes-and-animations-design.md).

**Architecture:** Themes = a registry in `src/core.js` that writes into the existing `THEMES` map (so `_palette()`, the `theme` attribute and report export all resolve registered names through lookups that already exist), plus a version counter that keys the palette cache. Animation = `plugins/animate/animate.mjs` wrapping `chart.update` on the instance (every tick source — app, `<wick-feed>`, paper — funnels through it), replaying the forming bar each rAF frame with an interpolated close; the final frame always writes the true bar.

**Tech Stack:** Plain ES modules, zero dependencies, `node:test` + `assert/strict`. Tests are **pure-function only** in this repo (element-level behavior is e2e's job) — plugins are tested against a `FakeChart` exactly like `plugins/replay/tests/replay.test.mjs` does.

**Branch:** `feat/themes-and-animate` (already created; design doc committed there). Test files follow the PR-number convention — this branch is expected to be PR **#84**, hence `tests/pr84-themes.test.mjs`.

**Budget facts (source of truth = `tests/size-budget.test.mjs`):** main entry ceiling is `BUDGET_GZ = 67 * 1024` (README's "68 KB" is stale); ichimoku landed at 66.5 KB, so ~0.5 KB headroom. `registerTheme` costs roughly that much — Task 4 measures and, if needed, raises the ceiling in its own commit with the why (the file's convention). The plugin gets its own 4 KB budget entry like every other plugin.

---

### Task 1: `registerTheme` / `getTheme` / `resolveThemeName` / `THEMES_VERSION` in core

**Files:**
- Test: `tests/pr84-themes.test.mjs` (create)
- Modify: `src/core.js` (after the `THEMES` object's closing `};`, before the `Indicators` divider — around line 408)

**Step 1: Write the failing test**

Create `tests/pr84-themes.test.mjs`:

```js
// PR #84 — registerTheme(): named custom themes over the built-ins, the
// theme-attribute resolver, and report colors for a registered theme.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THEMES, registerTheme, getTheme, resolveThemeName, THEMES_VERSION,
} from '../src/core.js';

test('registerTheme merges a partial palette over the dark base', () => {
  assert.equal(registerTheme('matrix', { bg: '#000000', up: '#22c55e' }), true);
  const m = getTheme('matrix');
  assert.equal(m.bg, '#000000');
  assert.equal(m.up, '#22c55e');
  assert.equal(m.down, THEMES.dark.down);   // inherited
  assert.equal(m.grid, THEMES.dark.grid);   // inherited
});

test('registerTheme drops unknown keys', () => {
  registerTheme('clean', { bg: '#111111', wow: '#ffffff' });
  assert.equal('wow' in getTheme('clean'), false);
});

test('overlay: a single string expands; an array pads with the base colors', () => {
  registerTheme('mono', { overlay: '#cccccc' });
  const o = getTheme('mono').overlay;
  assert.equal(o.length, THEMES.dark.overlay.length);
  assert.ok(o.every((c) => c === '#cccccc'));

  registerTheme('two', { overlay: ['#111111'] });
  const p = getTheme('two').overlay;
  assert.equal(p[0], '#111111');
  assert.equal(p[1], THEMES.dark.overlay[1]);
});

test('volAlpha coerces to a number; garbage falls back to the base value', () => {
  registerTheme('half', { volAlpha: '0.5' });
  assert.equal(getTheme('half').volAlpha, 0.5);
  registerTheme('bad', { volAlpha: 'nope' });
  assert.equal(getTheme('bad').volAlpha, THEMES.dark.volAlpha);
});

test('opts.base selects the merge base', () => {
  registerTheme('sun', { up: '#111111' }, { base: 'light' });
  assert.equal(getTheme('sun').bg, THEMES.light.bg);
});

test('invalid registrations return false and register nothing', () => {
  assert.equal(registerTheme('', {}), false);
  assert.equal(registerTheme('x', null), false);
  assert.equal(getTheme('x'), undefined);
});

test('re-registering overwrites and bumps THEMES_VERSION', () => {
  const v0 = THEMES_VERSION;
  registerTheme('twice', { bg: '#101010' });
  registerTheme('other', {});
  registerTheme('twice', { bg: '#202020' });
  assert.equal(getTheme('twice').bg, '#202020');
  assert.ok(THEMES_VERSION > v0);
});

test('resolveThemeName passes registered names, falls back to dark', () => {
  registerTheme('matrix', {});
  assert.equal(resolveThemeName('matrix'), 'matrix');
  assert.equal(resolveThemeName('light'), 'light');
  assert.equal(resolveThemeName('dark'), 'dark');
  assert.equal(resolveThemeName('nope'), 'dark');
  assert.equal(resolveThemeName(''), 'dark');
  assert.equal(resolveThemeName(null), 'dark');
});
```

**Step 2: Run test to verify it fails**

Run: `node --test tests/pr84-themes.test.mjs`
Expected: FAIL — `SyntaxError: The requested module '../src/core.js' does not provide an export named 'registerTheme'`

**Step 3: Write the implementation**

In `src/core.js`, directly after the `THEMES` object's closing `};` (before the `Indicators (pure functions over arrays)` divider), insert:

```js
/* ------------------------------------------------------------------ *
 * Named theme registry
 * ------------------------------------------------------------------ */

/** Bumped by every registerTheme() so palette caches can key on it. */
export let THEMES_VERSION = 1;

/**
 * Register a named theme over a built-in base. The merged palette is stored
 * in THEMES itself, so every THEMES[name] lookup — the `theme` attribute,
 * _palette(), report export — resolves it. Re-registering a name overwrites
 * and bumps THEMES_VERSION. Unknown palette keys are dropped; a string
 * `overlay` expands to the base length, an array pads with the base colors.
 * @param {string} name
 * @param {Record<string, string|number|string[]>} palette
 * @param {{ base?: string }} [opts]
 * @returns {boolean}
 */
export function registerTheme(name, palette, opts = {}) {
  if (typeof name !== 'string' || !name || !palette || typeof palette !== 'object') return false;
  const base = THEMES[opts.base] ? opts.base : 'dark';
  const out = { ...THEMES[base] };
  for (const k of Object.keys(out)) {
    if (!(k in palette)) continue;
    const v = palette[k];
    if (k === 'overlay') {
      if (typeof v === 'string' && v) out.overlay = out.overlay.map(() => v);
      else if (Array.isArray(v) && v.length) out.overlay = out.overlay.map((c, i) => v[i] || c);
    } else if (k === 'volAlpha') {
      const n = parseFloat(v);
      if (isNum(n)) out.volAlpha = n;
    } else if (typeof v === 'string' && v) {
      out[k] = v;
    }
  }
  THEMES[name] = out;
  THEMES_VERSION++;
  return true;
}

/** Look up a registered (or built-in) theme palette by name.
 * @param {string} name */
export function getTheme(name) {
  return THEMES[name];
}

/** Resolve a `theme` attribute value: any registered name passes through,
 *  anything else falls back to 'dark'. @param {string|null} val */
export function resolveThemeName(val) {
  return val && THEMES[val] ? val : 'dark';
}
```

(`isNum` is an existing local in `core.js` — it is already exported and used across the file.)

**Step 4: Run test to verify it passes**

Run: `node --test tests/pr84-themes.test.mjs`
Expected: PASS — 9 tests.

**Step 5: Commit**

```bash
git add tests/pr84-themes.test.mjs src/core.js
git commit -m "feat(themes): registerTheme() — named custom themes over the built-ins"
```

---

### Task 2: Wire the chart element — attribute, palette cache, re-export

**Files:**
- Modify: `src/wick-chart.js` (import list ~line 26; `theme` case ~line 497; `_palette()` ~lines 1485–1506; export block at file end)

**Step 1: Add the wiring tests to `tests/pr84-themes.test.mjs`**

Append (these pin the contract the wiring must uphold — resolver behavior is already covered; here we pin that the entry re-exports and that the pieces the element uses exist):

```js
test('the main entry re-exports registerTheme', async () => {
  const mod = await import('../src/wick-chart.js');
  assert.equal(typeof mod.registerTheme, 'function');
});
```

Note: importing `wick-chart.js` in Node is safe — it self-registers the element only `if (typeof customElements !== 'undefined')`.

**Step 2: Run to verify it fails**

Run: `node --test tests/pr84-themes.test.mjs`
Expected: the new test FAILs (`mod.registerTheme` is `undefined`).

**Step 3: Implement**

Three edits in `src/wick-chart.js`:

(a) Import list (~line 26) — extend the existing `from './core.js'` import:

```js
  THEMES, mergeOlderData, detectGaps, registerTheme, resolveThemeName, THEMES_VERSION,
```

(b) `attributeChangedCallback` `theme` case (~line 497) — replace:

```js
        case 'theme':
          this._theme = val === 'light' ? 'light' : 'dark';
```

with:

```js
        case 'theme':
          this._theme = resolveThemeName(val);
```

(c) `_palette()` (~lines 1485 and 1506) — key the cache on theme + registry version. Replace:

```js
      if (this._pal && this._palKey === this._theme) return this._pal;
```

with:

```js
      const palKey = this._theme + '' + THEMES_VERSION;
      if (this._pal && this._palKey === palKey) return this._pal;
```

and replace the assignment near the end of `_palette()`:

```js
      this._palKey = this._theme;
```

with:

```js
      this._palKey = palKey;
```

(d) File-end exports — replace:

```js
export default WickChart;
export { WickChart };
```

with:

```js
export default WickChart;
export { WickChart, registerTheme };
```

**Step 4: Run to verify it passes**

Run: `node --test tests/pr84-themes.test.mjs && node --check src/wick-chart.js`
Expected: PASS + no syntax errors.

**Step 5: Commit**

```bash
git add tests/pr84-themes.test.mjs src/wick-chart.js
git commit -m "feat(themes): theme attribute accepts registered names; palette cache keys on registry version"
```

---

### Task 3: Report export follows registered themes

**Files:**
- Test: `tests/pr84-themes.test.mjs` (extend)
- Modify: `src/report.js` (import line 24; `reportColors()` starting line 95)

**Step 1: Write the failing test**

Append to `tests/pr84-themes.test.mjs`:

```js
test('reportColors follows a registered theme in auto mode', async () => {
  const { reportColors } = await import('../src/report.js');
  registerTheme('matrix', { bg: '#000000', up: '#22c55e', down: '#ef4444' });
  const pal = reportColors({ nodeType: 1, theme: 'matrix' });
  assert.equal(pal.bg, '#000000');
  assert.equal(pal.up, '#22c55e');
  assert.equal(pal.down, '#ef4444');
  assert.equal(pal.light, false); // luminance('#000000') === 0
});

test('reportColors is unchanged for built-in theme names', async () => {
  const { reportColors } = await import('../src/report.js');
  const pal = reportColors({ nodeType: 1, theme: 'dark' });
  assert.equal(pal.bg, '#0d1117');
  assert.equal(pal.up, '#16c784');
});
```

**Step 2: Run to verify it fails**

Run: `node --test tests/pr84-themes.test.mjs`
Expected: the `matrix` test FAILs — `pal.bg` is `'#0d1117'` (report's own dark copy), not the registered `'#000000'`.

**Step 3: Implement**

In `src/report.js`:

(a) Line 24 — change:

```js
import { computeStats } from './core.js';
```

to:

```js
import { computeStats, getTheme } from './core.js';
```

(b) In `reportColors()` (line 95), after the `const pal = { ...PALETTES[...] };` line, insert (the existing `getComputedStyle` block below still runs and its `--wick-*` values keep winning — CSS variables stay the top layer):

```js
  if (key === 'auto') {
    const name = chart && chart.theme;
    const t = name && name !== 'light' && name !== 'dark' ? getTheme(name) : null;
    if (t) {
      pal.bg = t.bg; pal.text = t.textStrong; pal.muted = t.text;
      pal.up = t.up; pal.down = t.down; pal.accent = t.accent;
    }
  }
```

**Step 4: Run to verify it passes**

Run: `node --test tests/pr84-themes.test.mjs tests/pr66-report.test.mjs`
Expected: PASS (new tests + the existing report suite stays green — no behavior change for built-in names).

**Step 5: Commit**

```bash
git add tests/pr84-themes.test.mjs src/report.js
git commit -m "feat(report): exports follow registered themes"
```

---

### Task 4: Measure the budget; raise it in its own commit if needed

**Files:**
- Modify (conditionally): `tests/size-budget.test.mjs`

**Step 1: Run the budget test**

Run: `node --test tests/size-budget.test.mjs`
Expected: PASS if the addition fits in 67 KB; FAIL with the measured size in the message if not.

**Step 2 (only if FAIL): raise the ceiling in a dedicated commit**

In `tests/size-budget.test.mjs`, change `const BUDGET_GZ = 67 * 1024;` to `68 * 1024` and add one comment line next to the existing history comments (after the `66→67` ichimoku paragraph):

```js
// 67→68 KB: registerTheme() — the registry, the resolver and the version
// key. Landed at <MEASURED> KB gz.
```

Commit **alone** (the file's stated convention — the diff IS the budget conversation):

```bash
git add tests/size-budget.test.mjs
git commit -m "chore(budget): main entry 67→68 KB gz — the registerTheme surface"
```

Record the measured number in the commit body as well. If the test PASSed, skip this commit entirely and note the measured size for Task 11's docs.

---

### Task 5: `plugins/animate` — skeleton: attach/wrap/detach + passthrough modes

**Files:**
- Create: `plugins/animate/animate.mjs`, `plugins/animate/tests/animate.test.mjs`

**Step 1: Write the failing tests**

Create `plugins/animate/tests/animate.test.mjs`:

```js
// wickchart-animate — the easing engine over a fake chart + a pumped rAF:
// wrap/intercept/passthrough/retarget/flush/cancel all pinned without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachAnimate } from '../animate.mjs';

const T0 = 1_700_000_000_000;
const DT = 60_000;
const bars = Array.from({ length: 10 }, (_, i) => ({
  time: T0 + i * DT, open: 100, high: 101, low: 99, close: 100, volume: 50,
}));

class FakeChart {
  constructor() { this._d = bars.slice(); this.writes = []; }
  get data() { return this._d; }
  setData(b) { this._d = b; }
  update(b) {
    this.writes.push(b);
    const d = this._d, last = d[d.length - 1];
    if (last && b.time === last.time) d[d.length - 1] = b;
    else if (!last || b.time > last.time) d.push(b);
    else { const i = d.findIndex((x) => x.time === b.time); if (i >= 0) d[i] = b; else d.splice(0, 0, b); }
  }
}

// rAF stub the tests pump by hand: deterministic frame timestamps
let rafQ = [];
const installRaf = () => {
  rafQ = [];
  globalThis.requestAnimationFrame = (fn) => (rafQ.push(fn), rafQ.length);
  globalThis.cancelAnimationFrame = (id) => { if (rafQ[id - 1] !== undefined) rafQ[id - 1] = null; };
};
const frame = (t) => { const q = rafQ; rafQ = []; for (const fn of q) if (fn) fn(t); };

const tickOn = (time, close, over = {}) => ({ time, open: 100, high: 101, low: 99, close, volume: 60, ...over });

test('attachAnimate throws on a non-chart', () => {
  assert.throws(() => attachAnimate(null), TypeError);
  assert.throws(() => attachAnimate({}), TypeError);
});

test('wraps chart.update; detach restores the original', () => {
  installRaf();
  const chart = new FakeChart();
  const orig = chart.update;
  const anim = attachAnimate(chart, { duration: 0 });
  assert.notEqual(chart.update, orig);
  anim.detach();
  assert.equal(chart.update, orig);
});

test('duration 0 is a hard passthrough — one write, the exact bar, no frames', () => {
  installRaf();
  const chart = new FakeChart();
  attachAnimate(chart, { duration: 0 });
  const last = chart.data[chart.data.length - 1];
  const bar = tickOn(last.time, 105);
  chart.update(bar);
  assert.equal(chart.writes.length, 1);
  assert.equal(chart.writes[0], bar);
  assert.equal(chart.data[chart.data.length - 1].close, 105);
  frame(1000); // nothing scheduled
  assert.equal(chart.writes.length, 1);
});

test('prefers-reduced-motion is a hard passthrough', () => {
  installRaf();
  const mm = { matches: true, addEventListener() {}, removeEventListener() {} };
  globalThis.matchMedia = () => mm;
  try {
    const chart = new FakeChart();
    attachAnimate(chart);
    const last = chart.data[chart.data.length - 1];
    chart.update(tickOn(last.time, 107));
    assert.equal(chart.writes.length, 1);
    assert.equal(chart.writes[0].close, 107);
  } finally { delete globalThis.matchMedia; }
});
```

**Step 2: Run to verify it fails**

Run: `node --test plugins/animate/tests/animate.test.mjs`
Expected: FAIL — `Cannot find module '.../plugins/animate/animate.mjs'`

**Step 3: Write the implementation**

Create `plugins/animate/animate.mjs`:

```js
/**
 * wickchart-animate — live-price easing as a wickchart plugin: ticks on the
 * forming bar glide to their new close over a short ease instead of
 * teleporting. Runs entirely on the public data API (chart.update), wrapped
 * on the instance so every tick source — app code, <wick-feed>, paper — is
 * eased without wiring. Eased frames replace the forming bar with an
 * interpolated close (high/low clamped so the body never escapes its wick);
 * the final frame always writes the true bar. Attach once per chart.
 *
 *   import { attachAnimate } from 'wickchart-animate';
 *   const anim = attachAnimate(chart, { duration: 180 });   // ms, 0 = off
 *   anim.detach();
 *
 * opts: duration (default 180, 0 disables), easing ('ease-out' | 'linear' |
 * fn(t)), volume (ease volume too; default false).
 * prefers-reduced-motion is a hard passthrough.
 *
 * Caveat: eased frames are live ticks to the chart, so alert predicates and
 * online indicator recompute see interpolated closes — the linear path
 * between two real closes, at most `duration` of firing-time skew.
 */

const EASINGS = {
  'ease-out': (t) => 1 - Math.pow(1 - t, 3),
  linear: (t) => t,
};
const DEF_DURATION = 180;
const DUR_MAX = 1500;

const raf = typeof requestAnimationFrame === 'function'
  ? (fn) => requestAnimationFrame(fn)
  : (fn) => setTimeout(() => fn(Date.now()), 16);
const caf = typeof cancelAnimationFrame === 'function'
  ? (id) => cancelAnimationFrame(id)
  : clearTimeout;

export function attachAnimate(chart, opts = {}) {
  return new Animate(chart, opts);
}

export class Animate {
  constructor(chart, opts = {}) {
    if (!chart || typeof chart.update !== 'function' || !('data' in chart)) {
      throw new TypeError('attachAnimate(chart): the chart element is required');
    }
    this._chart = chart;
    this._dur = Math.max(0, Math.min(DUR_MAX, Number(opts.duration) || DEF_DURATION));
    this._easeFn = typeof opts.easing === 'function' ? opts.easing : (EASINGS[opts.easing] || EASINGS['ease-out']);
    this._volume = opts.volume === true;
    this._es = null; // the active ease: { time, from, to, real, cur, t0 }
    this._rafId = 0;
    this._mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this._onMq = null;
    if (this._mq) {
      this._onMq = () => { if (this._mq.matches) this._flush(); };
      if (this._mq.addEventListener) this._mq.addEventListener('change', this._onMq);
      else if (this._mq.addListener) this._mq.addListener(this._onMq);
    }
    // wrap update on the instance: every tick source funnels through it
    this._orig = chart.update;
    this._hadOwn = Object.prototype.hasOwnProperty.call(chart, 'update');
    this._prevOwn = this._hadOwn ? chart.update : null;
    chart.update = (bar) => this._tick(bar);
  }

  detach() {
    const c = this._chart;
    this._flush();
    if (this._mq && this._onMq) {
      if (this._mq.removeEventListener) this._mq.removeEventListener('change', this._onMq);
      else if (this._mq.removeListener) this._mq.removeListener(this._onMq);
    }
    if (this._hadOwn) c.update = this._prevOwn; else delete c.update;
  }

  /* ---------------- internals ---------------- */

  _reduced() { return !!this._mq && !!this._mq.matches; }

  _pass(bar) { return this._orig.call(this._chart, bar); }

  _tick(bar) {
    if (this._dur <= 0 || this._reduced() || !bar || !isFinite(Number(bar.close))) {
      return this._pass(bar);
    }
    return this._pass(bar); // easing branches land in Tasks 6–9
  }

  /** Write the true bar of an active ease (detach / reduced-motion / append). */
  _flush() {
    const es = this._es;
    if (!es) return;
    this._es = null;
    if (this._rafId) caf(this._rafId);
    this._rafId = 0;
    const d = this._chart.data;
    const last = d && d[d.length - 1];
    if (last && last.time === es.time) this._pass(es.real);
  }
}
```

**Step 4: Run to verify it passes**

Run: `node --test plugins/animate/tests/animate.test.mjs`
Expected: PASS — 4 tests.

**Step 5: Commit**

```bash
git add plugins/animate/animate.mjs plugins/animate/tests/animate.test.mjs
git commit -m "feat(animate): plugin skeleton — attach/detach wrap + passthrough modes"
```

---

### Task 6: The easing loop — eased frames, final true bar, wick guard

**Files:**
- Test: `plugins/animate/tests/animate.test.mjs` (extend)
- Modify: `plugins/animate/animate.mjs` (`_tick` easing branch + new `_frame`)

**Step 1: Write the failing tests**

Append:

```js
test('eases the forming-bar close and lands on the exact true bar', () => {
  installRaf();
  const chart = new FakeChart();
  attachAnimate(chart); // default 180ms ease-out
  const last = chart.data[chart.data.length - 1];
  chart.update(tickOn(last.time, 110));
  assert.equal(chart.writes.length, 0); // nothing until the first frame

  frame(1000); // t0 captured; k=0 writes the from value
  frame(1090); // k=0.5 → 105
  assert.ok(chart.writes[chart.writes.length - 1].close > 100);
  assert.ok(chart.writes[chart.writes.length - 1].close < 110);
  frame(1180); // k>=1 → the true bar, exactly
  const w = chart.writes[chart.writes.length - 1];
  assert.equal(w.close, 110);
  assert.equal(w.high, 101);
  assert.equal(w.volume, 60);
  assert.equal(rafQ.length, 0); // loop stopped
  assert.equal(chart.data[chart.data.length - 1].close, 110);
});

test('wick guard: the eased body never escapes high/low', () => {
  installRaf();
  const chart = new FakeChart();
  attachAnimate(chart);
  const last = chart.data[chart.data.length - 1];
  // a feed bar whose close exceeds its own high (malformed but must not break)
  chart.update(tickOn(last.time, 110, { high: 100 }));
  frame(1090); // eased close 105 > high 100
  const w = chart.writes[chart.writes.length - 1];
  assert.equal(w.close, 105);
  assert.equal(w.high, 105); // clamped up around the eased body
  assert.equal(w.low, 99);   // and down
});
```

**Step 2: Run to verify it fails**

Run: `node --test plugins/animate/tests/animate.test.mjs`
Expected: both new tests FAIL — with passthrough-only `_tick` the bar lands immediately (writes length 1, close 110 at once).

**Step 3: Implement**

In `plugins/animate/animate.mjs`, replace the placeholder easing line in `_tick`:

```js
    return this._pass(bar); // easing branches land in Tasks 6–9
```

with the forming-bar ease start (backfill/append branches come in Task 8):

```js
    const d = this._chart.data;
    const last = d && d[d.length - 1];
    if (!last || bar.time > last.time || bar.time < last.time) {
      return this._pass(bar); // new bars and backfills are facts (Task 8 refines)
    }
    // forming-bar tick: start (or retarget) the ease from the current display
    const es = this._es;
    this._es = {
      time: bar.time,
      from: last.close,
      to: Number(bar.close),
      real: bar,
      cur: last.close,
      t0: null,
    };
    if (!this._rafId) this._rafId = raf((t) => this._frame(t));
    return undefined;
```

and add `_frame` after `_tick`:

```js
  _frame(t) {
    this._rafId = 0;
    const es = this._es;
    if (!es) return; // stale frame after flush/detach
    const d = this._chart.data;
    const last = d && d[d.length - 1];
    if (!last || last.time !== es.time) { this._es = null; return; } // data moved
    if (es.t0 == null) es.t0 = t;
    const k = (t - es.t0) / this._dur;
    if (k >= 1) {
      this._es = null;
      return this._pass(es.real); // the final frame is always the true bar
    }
    es.cur = es.from + (es.to - es.from) * this._easeFn(k);
    const b = { ...es.real, close: es.cur };
    b.high = Math.max(es.real.high, es.cur);
    b.low = Math.min(es.real.low, es.cur);
    this._pass(b);
    this._rafId = raf((tt) => this._frame(tt));
  }
```

**Step 4: Run to verify it passes**

Run: `node --test plugins/animate/tests/animate.test.mjs`
Expected: PASS — 6 tests.

**Step 5: Commit**

```bash
git add plugins/animate/animate.mjs plugins/animate/tests/animate.test.mjs
git commit -m "feat(animate): eased frames on the forming bar, final true bar, wick guard"
```

---

### Task 7: Retarget mid-ease from the displayed value

**Files:**
- Test: `plugins/animate/tests/animate.test.mjs` (extend)
- Modify: `plugins/animate/animate.mjs` (`_tick` ease-start, two lines)

**Step 1: Write the failing test**

Append:

```js
test('a second tick mid-ease retargets from the displayed value — no jump', () => {
  installRaf();
  const chart = new FakeChart();
  attachAnimate(chart);
  const last = chart.data[chart.data.length - 1];
  chart.update(tickOn(last.time, 110));
  frame(1000);
  frame(1090); // displaying 105
  chart.update(tickOn(last.time, 120)); // retarget: 105 → 120
  frame(1180); // new t0 → k=0 → writes 105 again, never jumps
  const w = chart.writes[chart.writes.length - 1];
  assert.equal(w.close, 105);
  frame(1270); // k=0.5 → 112.5
  frame(1360); // k>=1 → the true bar
  const fin = chart.writes[chart.writes.length - 1];
  assert.equal(fin.close, 120);
  const closes = chart.writes.map((w2) => w2.close);
  assert.ok(closes.every((c, i) => i === 0 || c >= closes[i - 1])); // monotonic
});
```

**Step 2: Run to verify it fails**

Run: `node --test plugins/animate/tests/animate.test.mjs`
Expected: FAIL — with `from: last.close` the second ease starts from 100, the k=0 frame after retarget writes 100 (a visible jump backward from 105).

**Step 3: Implement**

In `_tick`'s ease-start, replace:

```js
    const es = this._es;
    this._es = {
      time: bar.time,
      from: last.close,
      to: Number(bar.close),
      real: bar,
      cur: last.close,
      t0: null,
    };
```

with:

```js
    const es = this._es;
    const from = es && es.time === bar.time ? es.cur : last.close;
    this._es = {
      time: bar.time,
      from,
      to: Number(bar.close),
      real: bar,
      cur: from,
      t0: null,
    };
```

**Step 4: Run to verify it passes**

Run: `node --test plugins/animate/tests/animate.test.mjs`
Expected: PASS — 7 tests.

**Step 5: Commit**

```bash
git add plugins/animate/animate.mjs plugins/animate/tests/animate.test.mjs
git commit -m "feat(animate): retarget mid-ease from the displayed value"
```

---

### Task 8: New bars flush the true bar first; backfills pass through un-eased

**Files:**
- Test: `plugins/animate/tests/animate.test.mjs` (extend)
- Modify: `plugins/animate/animate.mjs` (`_tick` time branches)

**Step 1: Write the failing tests**

Append:

```js
test('a new bar flushes the previous bar’s true value, then appends', () => {
  installRaf();
  const chart = new FakeChart();
  attachAnimate(chart);
  const last = chart.data[chart.data.length - 1];
  chart.update(tickOn(last.time, 110));
  frame(1000);
  frame(1090); // displaying 105, mid-ease
  const before = chart.data.length;
  chart.update(tickOn(last.time + DT, 98)); // the next bar opened
  const flush = chart.writes[chart.writes.length - 2];
  const append = chart.writes[chart.writes.length - 1];
  assert.equal(flush.close, 110); // true close of the eased bar
  assert.equal(append.close, 98); // the new bar, un-eased
  assert.equal(chart.data.length, before + 1);
  const atFlush = chart.writes.length;
  frame(1180); // no frames scheduled after the flush cancelled the loop
  assert.equal(chart.writes.length, atFlush); // no new writes
});

test('an older-time tick (backfill) passes through un-eased, ease unaffected', () => {
  installRaf();
  const chart = new FakeChart();
  attachAnimate(chart);
  const last = chart.data[chart.data.length - 1];
  chart.update(tickOn(last.time, 110));
  frame(1000);
  const writesBefore = chart.writes.length;
  chart.update(tickOn(last.time - DT, 100.5)); // historical correction
  assert.equal(chart.writes[chart.writes.length - 1].close, 100.5); // passed through
  frame(1180); // the ease still completes on the forming bar
  assert.equal(chart.data[chart.data.length - 1].close, 110);
  assert.ok(chart.writes.length > writesBefore);
});
```

**Step 2: Run to verify it fails**

Run: `node --test plugins/animate/tests/animate.test.mjs`
Expected: the flush test FAILs — the append branch currently passes the new bar through but the previous eased bar stays at its last interpolated close (no flush write of the true 110).

**Step 3: Implement**

In `_tick`, replace:

```js
    const d = this._chart.data;
    const last = d && d[d.length - 1];
    if (!last || bar.time > last.time || bar.time < last.time) {
      return this._pass(bar); // new bars and backfills are facts (Task 8 refines)
    }
```

with:

```js
    const d = this._chart.data;
    const last = d && d[d.length - 1];
    if (!last || bar.time > last.time) {
      // a new bar is a fact: flush any active ease to its true bar, then append
      this._flush();
      return this._pass(bar);
    }
    if (bar.time < last.time) {
      // backfill / historical correction: a fact, never eased; the forming
      // bar is untouched, so an active ease keeps running
      return this._pass(bar);
    }
```

**Step 4: Run to verify it passes**

Run: `node --test plugins/animate/tests/animate.test.mjs`
Expected: PASS — 9 tests.

**Step 5: Commit**

```bash
git add plugins/animate/animate.mjs plugins/animate/tests/animate.test.mjs
git commit -m "feat(animate): flush on new bars; backfills pass through un-eased"
```

---

### Task 9: Cancel when the data moves underneath; optional volume easing

**Files:**
- Test: `plugins/animate/tests/animate.test.mjs` (extend)
- Modify: `plugins/animate/animate.mjs` (`_frame` guard already written in Task 6 — add a regression test for it; volume in `_tick`/`_frame`)

The data-moved guard (`last.time !== es.time → cancel`) is already in `_frame` from Task 6; this task pins it with a test and adds the `volume` option.

**Step 1: Write the failing tests**

Append:

```js
test('setData mid-ease cancels silently — no eased write after the data moved', () => {
  installRaf();
  const chart = new FakeChart();
  attachAnimate(chart);
  const last = chart.data[chart.data.length - 1];
  chart.update(tickOn(last.time, 110));
  frame(1000);
  chart.setData(bars.slice(0, 5)); // the dataset moved under the ease
  const writes = chart.writes.length;
  frame(1090);
  frame(1180);
  assert.equal(chart.writes.length, writes); // nothing written, loop dead
  assert.equal(rafQ.length, 0);
});

test('detach mid-ease flushes the true bar', () => {
  installRaf();
  const chart = new FakeChart();
  const anim = attachAnimate(chart);
  const last = chart.data[chart.data.length - 1];
  chart.update(tickOn(last.time, 110));
  frame(1000);
  frame(1090); // displaying 105
  anim.detach();
  assert.equal(chart.writes[chart.writes.length - 1].close, 110);
});

test('volume eases too when asked', () => {
  installRaf();
  const chart = new FakeChart();
  attachAnimate(chart, { volume: true });
  const last = chart.data[chart.data.length - 1]; // volume 50
  chart.update(tickOn(last.time, 110, { volume: 100 }));
  frame(1000);
  frame(1090); // k=0.5
  const w = chart.writes[chart.writes.length - 1];
  assert.ok(w.volume > 50 && w.volume < 100);
  frame(1180);
  assert.equal(chart.writes[chart.writes.length - 1].volume, 100); // true value
});
```

**Step 2: Run to verify failures**

Run: `node --test plugins/animate/tests/animate.test.mjs`
Expected: the `setData` test PASSES already (guard from Task 6 — fine, it is a regression pin). The `volume` test FAILs (`w.volume` is 100 on every frame — volume currently passes through as a fact). The `detach` flush test PASSES (`_flush` exists from Task 5).

**Step 3: Implement volume easing**

(a) In `_tick`'s ease-start, track volume alongside close — replace the block from Task 7 with:

```js
    const es = this._es;
    const from = es && es.time === bar.time ? es.cur : last.close;
    const volFrom = this._volume && es && es.time === bar.time && typeof es.curVol === 'number'
      ? es.curVol
      : (typeof last.volume === 'number' ? last.volume : Number(bar.volume));
    this._es = {
      time: bar.time,
      from,
      to: Number(bar.close),
      real: bar,
      cur: from,
      volFrom,
      volTo: Number(bar.volume),
      curVol: volFrom,
      t0: null,
    };
```

(b) In `_frame`, after `es.cur = ...` add:

```js
    if (this._volume && isFinite(es.volFrom) && isFinite(es.volTo)) {
      es.curVol = es.volFrom + (es.volTo - es.volFrom) * this._easeFn(k);
      b.volume = es.curVol;
    }
```

(moving the `const b = { ...es.real, close: es.cur };` line above it, so the order is: compute `es.cur`, compute `b`, apply volume, apply the high/low clamp, `_pass(b)`.)

**Step 4: Run to verify it passes**

Run: `node --test plugins/animate/tests/animate.test.mjs`
Expected: PASS — 12 tests.

**Step 5: Commit**

```bash
git add plugins/animate/animate.mjs plugins/animate/tests/animate.test.mjs
git commit -m "feat(animate): cancel when the data moves underneath; optional volume easing"
```

---

### Task 10: Own CI budget + `package.json` wiring

**Files:**
- Modify: `tests/size-budget.test.mjs`, `package.json`

**Step 1: Wire the tests in**

(a) `package.json` — in the `test` script glob list, append after `"plugins/ai/tests/*.test.mjs"`:

```
"plugins/animate/tests/*.test.mjs"
```

(b) `package.json` — in the `ci` script, append at the end:

```
&& node --check plugins/animate/animate.mjs
```

(c) `tests/size-budget.test.mjs` — after the AI budget block (~the `AI_FILES` declaration), add:

```js
// animate: live-price easing — the update() wrapper and the eased frame
// writer, all display-path (no drawing, no new core surface).
const ANIMATE_BUDGET_GZ = 4 * 1024;
const ANIMATE_FILES = ['plugins/animate/animate.mjs'];
```

and after the AI budget test:

```js
test('wickchart-animate plugin stays under its (smaller) gzip budget', () => {
  let total = 0;
  const parts = [];
  for (const f of ANIMATE_FILES) {
    const n = gz(f);
    total += n;
    parts.push(`${f}: ${(n / 1024).toFixed(1)} KB gz`);
  }
  assert.ok(
    total <= ANIMATE_BUDGET_GZ,
    `wickchart-animate is ${(total / 1024).toFixed(1)} KB gz, budget is ${ANIMATE_BUDGET_GZ / 1024} KB\n  ${parts.join('\n  ')}`
  );
});
```

**Step 2: Verify**

Run: `node --test tests/size-budget.test.mjs && npm test`
Expected: PASS everywhere (the plugin lands ~2–3 KB gz; if over 4 KB, trim the header comment or raise to 5 KB with a why-comment).

**Step 3: Commit**

```bash
git add tests/size-budget.test.mjs package.json
git commit -m "chore(animate): own CI budget + test/ci wiring"
```

---

### Task 11: Docs — README, docs.html, plugins.html, CHANGELOG

**Files:**
- Modify: `README.md`, `docs.html`, `plugins.html`, `CHANGELOG.md`

**Step 1: README.md**

- Line ~161 bullet — extend: `**Themeable with CSS variables** — two built-in themes, \`registerTheme()\` for named custom themes, full control from outside the component (Shadow DOM friendly)`
- Line ~177 plugins list — insert `animate` after `replay` in the enumeration.
- Attribute table line ~309 — change the `theme` row's description to: `` `dark`, `light`, or any `registerTheme()` name ``
- `## Theming` (line ~1140) — append a subsection at the end of the Theming section:

```markdown
### Named custom themes — `registerTheme()`

Declare a branded palette once and use it by name (partial palettes merge
over a built-in base; `--wick-*` CSS variables still win on top):

```js
import { registerTheme } from 'wickchart';

registerTheme('matrix', {
  bg: '#000000', up: '#22c55e', down: '#ef4444', accent: '#4c8dff',
}, { base: 'dark' });
```
```html
<wick-chart theme="matrix"></wick-chart>
```

Re-registering a name overwrites it live. Report export follows the
registered theme automatically.
```

- After the `### Replay — the wickchart-replay plugin` section (~line 816), add a sibling section:

```markdown
### Animate — the `wickchart-animate` plugin

Live-price easing as opt-in bytes (~2 KB gz, own CI budget): ticks on the
forming bar glide to their new close instead of teleporting — the candle
body, last-price line, axis label and legend all ease together, because
they all derive from the last close. The plugin wraps `chart.update` on
the instance, so every tick source (app code, `<wick-feed>`, paper) is
eased with one line. The final frame always writes the true bar; new bars
and backfills are facts and land immediately; `prefers-reduced-motion`
and `duration: 0` are hard passthrough.

```js
npm install wickchart wickchart-animate   // animate is a separate opt-in package

import { attachAnimate } from 'wickchart-animate';

const anim = attachAnimate(chart, { duration: 180 });  // ms; 0 disables
anim.detach();
```

Eased frames are live ticks to the chart, so alert predicates see
interpolated closes — the linear path between two real closes, at most
`duration` of firing-time skew. Peer dependency: wickchart ≥ 2.3.
```

- Fix the stale budget claim in the *Why another chart library?* section: the enforced ceiling is whatever `BUDGET_GZ` says after Task 4 (67 or 68 KB) — make README match the test.

**Step 2: docs.html** — in the `<section id="theming">` (line ~738), append a `registerTheme()` code example mirroring the README one, and note the attribute accepts registered names.

**Step 3: plugins.html** — three touches, all mirroring the replay plugin's markup:

- Nav list (~line 193): add `<li><a href="#animate">animate — live-price easing<span class="pkg">animate</span></a></li>` after the replay item.
- Start table (~line 224): add a row — `<tr><td><a href="#animate">wickchart-animate</a></td><td>live-price easing — ticks glide to their new close</td><td>2 KB</td><td>≥ 2.3</td></tr>` (size = measured from Task 10).
- After the replay `<section id="replay">` block: add `<section id="animate">` with an `attachAnimate` code sample in the same highlighted-`<pre>` style, the caveat sentence, and — if cheap — a live playground toggle button that attaches/detaches on the hub's demo chart (copy the structure of another section's playground; if the hub's playground machinery doesn't fit, ship the static code sample only).

**Step 4: CHANGELOG.md** — add a `## 2.3.0` section at the top of the entries (mirroring the 2.2.0 entry's structure): under **Added** — `registerTheme()` named custom themes (core, `theme` attribute + report export follow); the `wickchart-animate` opt-in plugin. Mention the budget number from Task 4.

**Step 5: Verify + commit**

Run: `node --test tests/pr21-docs.test.mjs` (docs consistency suite, if it asserts plugin lists/sections — read it first and satisfy whatever it checks), then:

```bash
git add README.md docs.html plugins.html CHANGELOG.md
git commit -m "docs(themes,animate): README, docs.html, plugins hub, CHANGELOG"
```

---

### Task 12: Full verification

**Step 1:** `npm run build:types` — regenerates `types/`; `registerTheme` must appear in `types/core.d.ts` and `types/wick-chart.d.ts` (JSDoc-driven; no manual type files exist).
**Step 2:** `npm test` — everything green.
**Step 3:** `npm run ci` — the full gate: types + tests + `node --check` on every entry, including the new plugin.
**Step 4:** `npm run dev` and eyeball `http://localhost:5173/demo/`: set a registered theme from the console (`wickchart` is not a global — use the demo page's own import or add a temporary snippet), and attach the animate plugin to a ticking chart to feel the ease; check `prefers-reduced-motion` via DevTools rendering emulation.

No commit unless verification forced a fix (commit any fix with `fix(...)`).

---

## Verification summary

- **Themes:** 9+ unit tests in `tests/pr84-themes.test.mjs` (merge/drop/overlay/volAlpha/base/overwrite+version/resolver/re-export/report). Element rendering of registered themes rides the existing `_palette()` path — no new render code to test beyond it.
- **Animate:** 12 unit tests over a FakeChart with a pumped rAF — wrap/detach, both passthrough modes, easing landing on the true bar, wick guard, retarget monotonicity, append flush, backfill passthrough, setData cancel, detach flush, volume easing. Plus its own gzip-budget test.
- **Gates:** `npm test`, `npm run ci`, `npm run build:types` all green; main-entry budget either fits 67 KB or is raised in its own commit with the why.
- **Not covered (deliberate):** e2e/Playwright specs for the two features — the repo's e2e covers render integrity broadly; a dedicated spec is a reasonable follow-up PR, noted in the PR description.
