# Roadmap v3 — the strategy decisions

Date: 2026-10-01 · Status: decided (this doc) → [ROADMAP.md] (the plan)

## Context

The 1.x–2.x roadmap shipped in full: every feature track, the 2.0 plugin
split, the 2.1 polish track, 2.2 ichimoku, 2.3 themes + animate, and the
perf-budget CI gate (the last open line). The repo has no external demand
signal to inherit — zero issues ever filed, zero stars/forks — so the old
roadmap's closing clause ("whatever demand surfaces next") had nothing to
work with. A new roadmap had to be vision-led.

## The decisions

1. **Audience: portfolio / craft.** The next roadmap optimizes for a
   reviewer skimming the repo — "things I've never seen a chart do" and
   "hard engineering I know is difficult". Adoption/marketing work is
   explicitly out of scope; the demo pages carry the showcase duty.
   (Rejected: real-users/adoption — no distribution channel exists and
   building one isn't craft; own-tooling — would narrow, not sharpen;
   product foundation — a product needs a market first.)

2. **Shape: both flavors, as tracks.** The old roadmap's shape (feature
   tracks for wow, engineering tracks for rigor) worked; only the content
   changes.

3. **The old non-goals stay — the constraints are the story.** A WebGPU
   renderer and Rust/WASM compute were rejected as product calls and are
   rejected again as craft calls: zero-dependency, no build step, no
   binary blobs, no backend. "What the raw web platform can do" is itself
   the thesis; lifting the bans would dilute it. (This is a preference,
   not a permanence pledge — it is revisitable the day the goal changes
   back to product.)

4. **Centering: Intelligence (Approach A).** Two summits: chart
   intelligence (shape search + AI copilot) on the feature side; provable
   correctness and scale (golden vectors, fuzz/replay, the columnar store)
   on the engineering side. Sharing ("chart as an artifact") is the
   secondary track; a 3.0 hygiene cut closes.
   - Chosen because it is the most 2026-relevant portfolio signal, every
     item builds on machinery the project already owns (the agent
     registry, the signals/narrator analyzers, the worker compute path),
     and each summit is demoable solo.
   - Rejected **B — zero-backend social** (WebRTC co-view as flagship):
     serverless signaling is clunky and the headline demo needs two
     people; kept as a stretch item instead.
   - Rejected **C — breadth sprint** (no summits, many M items): reads as
     maintenance, not vision — directly against the portfolio goal.

## Consequences

- No adoption, SEO or docs-site work; the existing demo/docs pages are the
  showcase and get feature-linked as summits land.
- The shipped roadmap is archived as `ROADMAP-1.x-2.x.md`; `ROADMAP.md` is
  the v3 plan (the pattern ROADMAP-V2.md set for historical docs).
- Version framing: the plan spans 2.4 → 3.0; 3.0 is the stub-deletion
  hygiene cut promised since 2.0, not a rewrite.
- Per-feature implementation plans continue to land in `docs/plans/` as
  each summit starts — the roadmap is the strategy layer, not a build
  sequence.

[ROADMAP.md]: ../../ROADMAP.md
