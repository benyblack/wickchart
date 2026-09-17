/**
 * wickchart-ai/core — the pure agent surface: the tool manifest
 * (AI_TOOLS), the system prompt builder (aiPromptText) and the validated
 * op dispatcher (applyChartOps). No DOM, no network — LLM output is
 * untrusted input, so every op is whitelisted and validated before it
 * touches the chart, and a failing op reports {ok:false} instead of
 * throwing so an agent can self-correct.
 *
 * During 1.x these functions live in wickchart/core and are re-exported
 * here unchanged (the dispatcher shares parseIndicators/normalizeOverlays
 * with the element itself). At the 2.0 cut the manifest, prompt and
 * dispatcher move into this package — see ROADMAP-V2.md.
 */

export { AI_TOOLS, aiPromptText, applyChartOps } from 'wickchart/core';
