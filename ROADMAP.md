# WickChart Roadmap — v3

North star: **"The most capable financial chart that runs on the raw web
platform — capabilities no commercial platform ships, on correctness that
can be checked, with zero dependencies and no build step."**

The 1.x–2.x roadmap shipped in full (see
[ROADMAP-1.x-2.x.md](./ROADMAP-1.x-2.x.md) — every track,
every line, through the perf-budget CI gate). It had no external demand
signal to inherit (zero issues ever filed), so this roadmap is vision-led
and serves a portfolio/craft goal: a reviewer skimming the repo should see
things no chart library does *and* hard engineering they know is difficult.
The strategy decisions behind this file are recorded in
`docs/plans/2026-10-01-roadmap-v3-design.md`.

Every item must survive two tests:

1. **Raw web platform** — no backend, no toolchain, no binary blobs, no
   dependencies. The constraints are the story, not a limitation to engineer
   around.
2. **Single-tag ergonomics** — one tag, sane defaults; everything opt-in
   stays a plugin with its own budget.

Effort: **S** ≤ a day · **M** a few days · **L** a week+. Spans 2.4 → 3.0
(3.0 is the hygiene cut at the end, not a rewrite).

---

## Track 1 — Chart intelligence (the feature summit)

| Feature | What & why | Effort | Notes |
|---|---|---|---|
| ~~**Shape & pattern search**~~ ✅ shipped | Brush any region → find every similar occurrence in history, ranked by z-normalized distance, ghosted onto the chart with a matches list (`chart.findShape()`, `wick:shape`). Matrix-profile-class similarity search shipped inside a web chart — nobody has it. | L | Landed sync (not worker): a single O(n log n) FFT pass measures interactive at any history size, so the offload wasn't needed — 100k bars search in ~30 ms. Greedy exclusion collapses overlaps; query/match bands render until cleared; golden-vectored against a brute-force reference. |
| **AI chart copilot** | Natural language → validated chart operations through the existing agent registry: "add a 21 EMA and show me where RSI diverged", "set up a long risk plan around the last pivot". Chart state → natural language. | M–L | The moat already exists: `wickchart-ai`'s validated dispatcher (`set_indicators` etc.) — no eval, URL-safe tokens. Deterministic rule-based intent core; an LLM is a pluggable accelerator, never a dependency. |
| Briefing mode | One command synthesizes signals + smart annotations + visible-range stats + the narrate timeline into a structured markdown briefing. "Explain this chart" as a first-class artifact. | S–M | Pure composition of existing parts (`getDataWindow`, signals plugin, narrator analyzer). |

## Track 2 — Chart as an artifact (sharing, the zero-dep flex)

| Feature | What & why | Effort | Notes |
|---|---|---|---|
| **Single-file export** | `exportChart({ standalone: true })` → one self-contained `.html`: the module inlined, the state JSON, optional story/scenario, opens offline. Send a *chart*, not a screenshot. | M | Only possible because the whole library is one zero-dependency module — the constraint pays off. Same machinery exports narrated stories as playable files. |
| Open a shared chart | Drag a shared file onto any page with the element → state restores (or self-opens standalone). | S | The inverse of export; makes the artifact round-trip. |
| SVG snapshot | The same draw model emitted as vector SVG — print/docs quality, tiny files. | S–M | The interesting engineering: a thin command-recorder between the draw calls and the canvas context, with an SVG emitter behind it. `exportPNG`/report reuse it. |
| P2P co-view (stretch) | Today's co-view syncs *tabs* (BroadcastChannel). WebRTC data channels with copy-paste signaling sync *people* — shared cursors and drawings, still zero backend. | M–L | Deliberately last in the track: signaling without a server is clunky to demo solo; lands only if the rest of the track clears early. |

## Track 3 — Provable correctness & scale (the engineering summit)

| Feature | What & why | Effort | Notes |
|---|---|---|---|
| **Golden-vector correctness** | Every built-in indicator checked against reference vectors — hand-derived fixtures cross-checked against TA-Lib runs, recorded as JSON, run as differential tests; the pass/fail matrix published in docs. "Trust the math" becomes checkable, not claimed. | M | The matrix page is the artifact a reviewer actually looks at. Worker path inherits the fixtures for free (same compute kernels). |
| **Fuzz + deterministic replay** | Property-based fuzzing of bars/attrs/gestures (CDP-driven input events), seeds recorded, any failure replayable byte-exact. | M | Extends the existing e2e harness; the size and perf gates get a correctness sibling. |
| **Columnar typed-array store** | The deferred D6 decision, reopened *by choice* as an engineering showcase: SoA `Float64` columns as the internal store, typed-column ingestion (`setData({ columns })`, additive), a compact binary wire format for histories. Target: 5M-bar histories, flat default view, memory density documented. | L | D6's reopen trigger was "≥5M bars or sub-16 ms low-end budgets" — a deliberate reopen for the craft signal, with a spike + decision doc before the full commitment. Render stays O(pixel columns); the wins are memory, scan and ingest. |
| OffscreenCanvas render thread | Opt-in: painting in a worker so the main thread stays free for host-app work. | M–L | Transfer canvas control off the main thread; Safari fallback; the hover layer stays local to input. |

## Track 4 — Hygiene, access, 3.0

| Feature | What & why | Effort | Notes |
|---|---|---|---|
| A11y traversal | Full keyboard chart navigation — arrow through bars with spoken/ARIA readouts, roles on the HUD, sonify 2.0 interval earcons. Screen-reader traders get a chart, not a picture of one. | M | Sonification exists; this finishes the job. Rare even among commercial charts. |
| **3.0 cut** | Delete the 2.0 warn-once stubs (promised "in 3.0"), prune surface that 2.x taught us better, tighten types. | S–M | Additive-first: 3.0 earns its number, it doesn't factory-reset the API. |

---

### Non-goals (identity, not reluctance)

A WebGL/WebGPU renderer (the Canvas 2D + columnar-dowsampling floor already
beats the frame budget — revisit only with profiler evidence), Rust/WASM
(no toolchain, no binary blobs), any backend server (P2P and
BroadcastChannel only), dependencies of any kind, a build step.

---

## Recommended first five PRs (value ÷ effort, portfolio-optic)

1. **Golden-vector correctness harness** + the trend/oscillator set — the
   rigor artifact lands first and everything after cites it. *M* ✅ shipped
2. **Shape & pattern search** — the flagship feature; built on tested
   ground. *L* ✅ shipped
3. **Single-file export + open** — the zero-dep flex nobody else can copy. *M*
4. **Briefing mode** — cheap, composes existing parts into a visible wow. *S–M*
5. **Fuzz + deterministic replay harness** — the third CI gate. *M*

The columnar store follows as PR six, gated on its spike + decision doc.

Each PR lands with the size and perf gates green — both enforced in CI now,
not promised.
