# WickChart 2.0 — the plan

Status: **proposal for discussion** (linked from ROADMAP.md). Numbers cite
the main entry as of v1.7.0 (73.89 KB gz, 74 KB budget) and the per-feature
reclaim measurements recorded in `tests/size-budget.test.mjs`; re-measure at
implementation time.

## Why a 2.0, and why now

Two debts are deliberately major-version-shaped — both have been documented
and deferred for exactly this conversation:

1. **The core entry carries ~9.6 KB of opt-in features** (sonification,
   narrator, story, co-view/presence, scenario + risk plan, AI helpers).
   They were inventoried when the budget was last raised; extracting them
   was rejected for 1.x only because it breaks public API
   (`chart.narrate()`, `playStory()`, `getPeers()`, the `sonify` and
   `co-view` attributes, …), which is a major-version decision.
2. **The 0.x `hab-*` aliases** (deprecated since the 1.0 rebrand, removed
   "in 2.0" by every comment that mentions them): `<hab-chart>`,
   `<hab-feed>`, `hab:*` events, `--hab-*` CSS fallbacks, the
   `HabChart`/`HabFeed` classes, the `hab-feed:*` event aliases and the
   `hab-co-view:` BroadcastChannel prefix.

A major should be **minimal and mechanical**. Everything additive — the
spread pane, i18n, presets, downsampling, the offscreen hover layer, the
columnar store — stays on main as 1.8/1.9 and inherits into 2.0 unchanged.

## Goal and definition of done

- Main entry (`core.js` + `wick-chart.js`) back to **≤ 65 KB gz**
  (73.89 − ~9.6 ≈ 64.3; new budget ceiling **66 KB**).
- **Zero `hab-` strings** in `src/` (grep-clean).
- Four new plugin packages published, each with its own gzip budget, tests,
  README and a plugins-hub section with a live playground.
- Docs, demos, e2e and the pr21 coverage guard migrated; migration table in
  CHANGELOG.md; tag `v2.0.0` + GitHub Release.

Non-goals (unchanged): WebGL renderer, backend/social layer, indicator
marketplace, a rewrite.

## The split — what moves where

| Package | Moves (public surface) | Recorded gz | Notes |
|---|---|---|---|
| `wickchart-narrator` | `narrate()`, `walk()`, `stopWalk()`, `playRange()` (sonification), `sonify` attribute, `captureScene()`, `getStory()`, `playStory()`, `stopStory()` | ~3.9 KB | One package for the whole "guided playback" family — walk, story and sonification share the playback-interruption machinery and the future-space camera math. Sonify alone (1.11 KB) does not justify an npm package. |
| `wickchart-coview` | `co-view` / `co-view-name` attributes, `getPeers()`, presence bands, the BroadcastChannel protocol | ~1.79 KB | The channel prefix loses its `hab-` history in 2.0 (see below). |
| `wickchart-scenario` | `setScenario()` / `clearScenario()`, `setRiskPlan()` / `clearRiskPlan()`, σ-cones + R-multiple rendering | ~1.86 KB | Scenario and risk share the future-space projection renderer; they move together. |
| `wickchart-ai` | `aiTools()`, `aiPrompt()`, `aiContext()`, `applyAI()`, `ask()` | ~2.01 KB | `getDataWindow()` **stays in core** — it is a data API (and the demo's Explain button), not an LLM API; `ask()` composes it from the plugin. |

**Calls keep their shape.** Each `attachX(chart)` installs the familiar
methods *on the instance* (`chart.narrate = …`), so existing call sites
survive with one added import line — the same ergonomics trade the plugin
family already makes (`attachReplay`, `attachPaper`, …). The AI registry
functions on the class stay (`AI_TOOLS` lives in core.js; `ask()` merely
drives it) — verify during extraction whether `core.js` bytes should move
with the package instead.

`getState()`/`setState()` are **not affected**: none of the split features
serialize through it today (scenario/risk/story manage their own state).

## The alias removal — full inventory

| 0.x name | 2.0 |
|---|---|
| `<hab-chart>` element | removed (register `<wick-chart>`) |
| `<hab-feed>` element | removed |
| `HabChart` / `HabFeed` exports | removed |
| `hab:*` event aliases (every event fires twice today) | removed — `wick:*` only |
| `hab-feed:*` event aliases | removed — `wick-feed:*` only |
| `--hab-*` CSS variable fallbacks | removed — `--wick-*` only |
| `hab-co-view:` BroadcastChannel prefix | `wick-co-view:` only (already the 1.x prefix; the legacy pairing note in README goes) |
| README "0.x migration" section | replaced by a 1.x → 2.x section |

Removed core methods (moved to plugins) get **warn-once stubs** for one
major: `chart.narrate()` without the plugin logs
`wickchart: narrate() moved to the wickchart-narrator package in 2.0` and
no-ops. Stubs cost a few dozen bytes, turn every breakage into a readable
message, and can be deleted in 3.0.

## Delivery strategy — prepare additively, cut atomically

No long-lived branch. The four packages are *additive* — they can be built,
tested, documented and playground-ed on main during 1.x (nothing imports
them; attaching before 2.0 simply overrides the core method with the same
behavior). Then one PR flips the world:

| # | PR | Size |
|---|---|---|
| 1 | `wickchart-narrator` package (walk + story + sonify) + tests + hub section | M |
| 2 | `wickchart-coview` + tests + hub section | S–M |
| 3 | `wickchart-scenario` (scenario + risk) + tests + hub section | S–M |
| 4 | `wickchart-ai` + tests + hub section | S–M |
| 5 | docs.html sections migrate to the plugins hub; pr21 guard list updated; demos re-wired (declarative/AI buttons import the packages) | M |
| 6 | migration notes: README 1.x→2.x section, CHANGELOG draft, deprecation warnings added in a 1.7.x patch release (`console.warn('hab-* aliases are removed in 2.0')` on first alias use) | S |
| 7 | **the cut**: remove the six core feature regions + all `hab-*` aliases, add warn-once stubs, shrink the budget 74 → 66 KB, move pr23/pr24/pr25/pr26/pr27/pr29 tests into their packages, drop the mount-spec alias test, invert pr17-rebrand, bump 2.0.0 | M |
| 8 | release 2.0.0: tag, GitHub Release, `npm publish` × 5 (core + 4 packages) | S |

PRs 1–6 can land as 1.8.0-track work; PR 7 is atomic and reviewed as the
whole breaking diff. If a 1.x bugfix is needed post-cut, it cherry-picks to
a `v1` branch for a 1.9.x (judged then; the hope is "cut and move on").

## Test & site migration map

- `tests/pr27-narrator`, `pr29-story` → `plugins/narrator/tests/`; `pr26-presence` → coview; `pr24-scenario` + `pr25-risk-plan` → scenario; `pr23-agent` → ai (keep `pr16-datawindow` in core tests — `getDataWindow` stays).
- `tests/pr17-rebrand.test.mjs` inverts: from "aliases still work" to "no `hab-` remains".
- `tests/pr21-docs.test.mjs`: method/attribute/event lists shrink accordingly.
- docs.html: six sections (narrate, story, coview, scenario, riskplan, ai + agent) move to the plugins hub; TOC on both pages updated; e2e `pages.spec` unaffected (pages still exist).
- Demos: the demo app's Explain/AI buttons gain one import; the co-view demo pairs only 2.0 tabs (documented).
- e2e visual baselines regenerate (core render output is unchanged in theory — scenarios/risk are plugin-drawn — but the axis/legend code paths shift; refresh per platform).

## Risks & mitigations

- **Discoverability drop** — features leaving the core are less "just there". Mitigation: warn-once stubs with the package name; the plugins hub documents everything with playgrounds; README's feature grid links the packages.
- **Co-view pairing break** — a 1.x tab and a 2.0 tab won't pair (channel prefix history). Same note pattern as the 0.x→1.x transition; acceptable.
- **Budget under-delivers** — if the post-split entry measures > 65 KB, the remainder is comment/arity fat in the remaining code, not a reason to move more features; decide at cut time with the budget test as the arbiter.
- **Story/scenario share of future-space code** — `_rightMargin()` reserves future space when a scenario exists; that hook stays in core as a small public seam (`chart._scenario` becomes a documented-ish plugin contract via the layer/dock API or a tiny reserved-space attribute). Settle in PR 3; worst case a ~100-byte core seam remains.

## Open decisions (recommendations in bold)

1. **Package granularity** — 4 packages as tabled (narrator absorbs sonify + story). Alternative: 6 micro-packages matching the original inventory; rejected: two of them are ~1.1–1.6 KB, below the dignity of an npm package.
2. **`getDataWindow()` stays in core** (data API, used by the demo and `ask()`). Alternative: moves with `wickchart-ai`; rejected: it's generally useful and documented outside the AI sections.
3. **Warn-once stubs for moved methods** — yes, deleted in 3.0. Alternative: hard `TypeError`; rejected: worse first contact for upgraders.
4. **A 1.7.x deprecation-warning patch release** before the cut — yes (PR 6 ships as 1.7.1). Alternative: cut cold; rejected: the warning costs nothing and reaches pinned-version users via changelogs.
5. **v1 maintenance branch after the cut** — default no; cherry-pick path documented, act only if something lands that matters to pinned 1.x users.
