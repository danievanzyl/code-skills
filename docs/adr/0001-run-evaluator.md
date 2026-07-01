---
status: accepted
---

# Run Evaluator: transcript-based, on-box, advisory-first, per-role attribution

## Context

The repo's AFK loop runs a **Runner** (implements an issue, opens a PR) then a
**Reviewer** (fixes the PR to make it mergeable). We want visibility into *how*
both agents arrive at solutions — the SuperCube "interrogate the process" goal.
The purpose is staged: **visibility first (B) → merge gate (A) → a feedback loop
that improves the skills/agents themselves (C)**. C reframes everything: findings
only pay off if they are attributable to the specific skill/agent that caused
them, so the data model must support attribution from day one.

## Decision

An out-of-band, read-only **Evaluator** scores each **Run** and emits a
**Scorecard**.

- **Substrate: the Claude Code transcript.** Each agent's transcript `.jsonl`
  already *is* its Trajectory — full reasoning + tool-call tree, zero
  instrumentation. We do not adopt OpenTelemetry: we don't own the Claude Code
  agent loop, so vendor-neutral GenAI spans aren't available for our own agents
  (OTel is the right answer only where we own the runtime, e.g. a custom
  orchestrator — a separate horizon). Outcome data comes from `git`/`gh`.
- **Both agents captured.** The Runner *and* the Reviewer are worktree-isolated
  sub-agents of the `afk-issue` orchestration; each fires its own
  `SubagentStop`. A capture hook on **both** matchers links each Trajectory to
  the PR (append-only, keyed by PR#, tagged with role). The Evaluator triggers
  on the Reviewer's stop, by which point both Trajectories exist.
- **Per-role + per-skill attribution.** Every Scorecard finding carries
  `{role, skill?/tool?, dimension}`. Separate **Runner** and **Reviewer**
  rubrics — the Reviewer's "genuinely reviewed vs rubber-stamped" is judged on
  evidence of inspection (read files + ran tests), *not* commit count (zero
  commits can be a legitimate "nothing to fix").
- **Four dimensions: Outcome · Process · Security · Efficiency.** Computation
  drives gate-eligibility:
  - **Security** — deterministic rules (destructive commands, secret material,
    egress). The only dimension eligible to block a merge.
  - **Efficiency** — deterministic extraction (input/output tokens, cache
    reads, tool-call count, span timestamps for wall-clock), compared per-issue
    over time. Advisory trend metric, never a gate.
  - **Outcome** — deterministic where possible (tests/CI) + LLM judge for
    "does the diff actually solve the issue". Advisory.
  - **Process** — reference-free LLM judge against the rubric. Advisory.
- **Advisory-first.** v1 publishes a Scorecard (PR comment) and never blocks an
  agent. Nothing is promoted to a required check until it is either deterministic
  or a **calibrated** judge (Spearman ≥ ~0.7 vs ≥50 human labels).
- **On-box, with one exception.** Transcripts never leave the box. The one thing
  that does is a **secret-redacted** Trajectory sent to the (swappable Claude)
  judge — the Security scorer runs first partly to *redact* what the judge sees.
- **Persistence + version stamp.** Every Scorecard is appended to an on-box JSONL
  log, stamped with the plugin release version **and** the git SHA of
  `agents/`+`skills/` that ran. That stamp is the make-or-break enabler for C
  (correlating score trends with prompt changes) — cheap now, impossible
  retroactively. No backend/dashboard until `jq` genuinely isn't enough.

## Considered options (rejected)

- **OpenTelemetry / OpenLLMetry / Langfuse** — right substrate for a runtime we
  own, but unavailable for our own Claude Code agents and heavy ops (ClickHouse
  et al.). Deferred to the orchestrator/SuperCube horizon.
- **Golden trajectories / tool-call F1** — strongest process signal but heavy
  human authoring and brittle to valid alternate paths. Deferred to phase C;
  ground truth must be human-authored, never agent-written.
- **Judge as a v1 gate** — gating on an uncalibrated nondeterministic judge
  erodes trust on the first false block. Judge is advisory until calibrated.
- **Session-tracking hooks (Pre/PostToolUse)** — unnecessary; the transcript
  already is the Trajectory. The only hook is a linker.

## Consequences

- **Build staging.** Stage 0 proves the pipe deterministically: dual-capture →
  Security + Efficiency scorers → role-attributed, version-stamped Scorecard →
  JSONL + PR comment, exit 0. Stage 1 adds the advisory judge once capture is
  proven. Later: Security → required check; golden cases + the C loop; a backend.
- **"Worked" for Stage 0** = both Trajectories linked to the right PR; per-role
  (not blob) findings; version stamp + efficiency captured; never blocks the agent.
- **Headless `afk.sh` path** (Runner top-level, no Reviewer) gets no auto-eval in
  v1; the dual-agent design targets the `afk-issue` path only.
- **Reconcile with `feat/run-evaluator`.** A prior branch implements much of this
  (transcript-based, on-box, advisory-first, security-gated) but lacks the four
  deltas this design adds: the Efficiency dimension, both-agent capture, a
  Reviewer rubric + rubber-stamp detection, and the version stamp. Decision: fold
  these deltas into that branch's `eval/` (not a parallel implementation), and
  **re-author the Security rules fresh** rather than inherit the prior set.
