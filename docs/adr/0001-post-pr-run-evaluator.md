---
status: accepted
---

# Post-PR Run Evaluator: hook-as-linker + co-located read-only analyzer

## Context

AFK agents (the **Runner**) open PRs; the **Reviewer** (`code-reviewer`) reviews and fixes the diff. We want to additionally *score* each Run — its outcome (diff), its process (the path the agent took), and its security posture — to give visibility into *how* agents arrive at solutions (the SuperCube "interrogate the process" goal). The open question was whether we need session-tracking hooks (PreToolUse/PostToolUse) to capture the agent's session before another agent analyses it.

## Decision

We do **not** capture the session via tracking hooks. The Claude Code transcript `.jsonl` (and `afk.sh`'s `stream-json`) already **is** the Trajectory. We add:

1. A uniform `Stop` + `SubagentStop` hook acting purely as a **linker** — it derives PR# from the worktree (via `gh`) and writes `manifest[pr#] = {transcript_path, sha, run_id}`. (`Stop` covers the headless `afk.sh` path where the Runner is the top-level agent; `SubagentStop` covers the `afk-issue` path where the Runner is a spawned sub-agent.)
2. A **read-only Evaluator** that runs as the final stage *after* the Reviewer (it never mutates the diff — you can't objectively score work you also edited). It is an **out-of-band analyzer in the skill-vetter mould**: deterministic scorers in code + one structured Claude call (reference-free judge), emitting a **Scorecard** JSON.
3. The Evaluator runs **co-located** with the Run (on the box that holds the manifest + transcript), so no transcript ever leaves the box. It publishes results to the PR: a **required** `eval/security` check (deterministic security rules — destructive commands, secret exposure, egress — are the only v1 hard gate) plus an **advisory** `eval/scorecard` comment/non-required status for budget, scope, process, and outcome.

It scores against a single versioned **Rubric** of global rules — **no per-issue golden trajectories** in v1.

## Considered options (rejected)

- **PreToolUse/PostToolUse session-tracking hooks** — unnecessary; the transcript already captures the Trajectory.
- **In-session Claude Code sub-agent** (like `code-reviewer`) — nondeterministic scoring, hard to unit-test, weak as a hard gate.
- **Separate CI container** — would require shipping transcripts off-box (size + secrets-in-transcript risk); co-location avoids it while still gating via branch protection.
- **OpenTelemetry spans** — right long-term substrate, overkill for v1.
- **Golden trajectory per issue / tool-call F1** — strongest signal but heavy human authoring and brittle to valid alternate paths; deferred to a later phase.
- **Full gate day 1 (incl. LLM judge)** — gating on an uncalibrated, nondeterministic judge risks flaky blocks and eroded trust; only deterministic security rules block in v1.

## Consequences

- **Where it lives (updated on graduation).** The Evaluator was prototyped in `voight/`; it has now graduated **whole** into this repo under `eval/` (analyzer + capture hooks + rubric + tests in one place — the simplest first integration, matching where the AFK flow + `hooks.json` already are). The eventual cross-repo split envisaged below is **deferred**, not abandoned.
- **The manifest is a linker artifact, not orchestration state.** This repo's AFK orchestration deliberately holds correctness data in the orchestrator and keeps hooks audit-only (no state files) — because a worktree-isolated sub-agent runs on a harness-named branch and nothing reliable can be reconstructed after the fact. The capture manifest is a **narrow, deliberate exception**: only the `Stop`/`SubagentStop` hook payload carries the sub-agent's `transcript_path`, so the orchestrator *cannot* obtain it — a hook-written link (PR# → transcript) is the only mechanism that works. It is keyed by PR# (resolved from the branch via `gh`, exactly as `afk-handoff.sh` does), append-only, and read out-of-band by the Evaluator; it is never read for control flow.
- **Rollout is advisory-first.** `eval/security` is published as a commit status + Scorecard comment but is **not** wired as a required branch-protection check yet, and the trigger hook never passes `--fail-on-gate` and always exits 0. Promoting the security dimension to an actual merge gate is a branch-protection change; promoting any advisory dimension (process/outcome) to a gate additionally requires first calibrating the judge against human labels (target Spearman ≥ 0.7).
- **Runtime dependency: `bun`.** Capture + eval both need `bun` on the box. The `afk-issue` path runs on the host (bun present). The headless `afk.sh` path runs inside `docker sandbox run claude` — bun there is **unverified**; the capture wrapper logs a health line when bun is missing so the silent no-op is visible. The headless path also has no Reviewer stage, so it has no automatic Evaluator trigger yet (manual `eval-pr.ts` until it grows one).
- **Future split (deferred).** The analyzer is expected to graduate into a `pe-ai-skills-hooks` plugin (sibling to skill-vetter, reusing its Anthropic SDK + structured-output harness for the LLM judge), with the capture hooks staying here. Track that cross-repo split with a CONTEXT-MAP when it lands. Domain glossary: `CONTEXT.md`.
- Open items deferred: LLM-as-judge module (process/outcome quality — the `advisory` slot in `buildScorecard` is already shaped for it); judge model + per-Run cost ceiling; calibration plan; step/cost budget thresholds (need baseline data); exact final Scorecard schema.
