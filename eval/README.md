# Run Evaluator (`eval/`)

Post-PR **Run Evaluator** — a read-only analyzer that scores an autonomous
agent's Run (its Trajectory + the PR diff) against a versioned Rubric and posts a
**security-gated PR check**. Graduated from the `voight` prototype; design and
rejected alternatives in [`../docs/adr/0001-post-pr-run-evaluator.md`](../docs/adr/0001-post-pr-run-evaluator.md).
Domain glossary: [`../CONTEXT.md`](../CONTEXT.md).

## Where it fits

```
Runner   ──opens PR──▶  Stop | SubagentStop hook  → hooks/capture-run.sh
                           └─ links PR# → transcript in the manifest
Reviewer ──fixes + pushes──▶ (code-reviewer)       → hooks/code-reviewer-push.sh
Evaluator  (code-reviewer SubagentStop)            → hooks/run-evaluator.sh
   manifest → Trajectory + diff
   ├─ deterministic security scorer   ← the v1 HARD GATE (advisory until made a required check)
   └─ (budget / scope / LLM judge      ← advisory, not yet implemented)
   → Scorecard → gh check `eval/security` + PR comment
```

The agent's **Trajectory already exists** as its Claude Code transcript `.jsonl`
(or `afk.sh` stream-json) — we don't track it with PreToolUse/PostToolUse hooks.
The only hook is a **linker** that records which transcript belongs to which PR.

## What's implemented (first slice)

- **Trajectory parser** (`src/trajectory/parser.ts`) — transcript `.jsonl` → tool calls.
- **Deterministic security scorer** (`src/scorers/security.ts`) — destructive
  commands, secret material (masked in output), and egress to non-allowlisted
  hosts. The only dimension that can block a merge in v1.
- **Rubric** (`rubric.yaml`) — versioned global rules; no per-issue goldens.
- **Scorecard** (`src/scorecard/build.ts`) — security is a hard floor; advisory
  dimensions are reported but never gate.
- **Manifest linker** (`src/manifest.ts`, `scripts/capture-run.ts`).
- **CLI** (`scripts/eval-pr.ts`) — resolve → score → print or publish.

Not yet built (ADR-0001 open items): the LLM-as-judge call (process/outcome
quality), the budget/scope scorers, judge calibration, and final thresholds.

## Usage

```bash
cd eval
bun install
bun test
bun run typecheck

# Dry-run against a transcript (no PR / network needed):
bun run scripts/eval-pr.ts --pr 123 --transcript path/to/transcript.jsonl

# Real run: resolve the transcript from the manifest, fetch the diff, publish:
bun run scripts/eval-pr.ts --pr 123 --repo owner/repo --publish

# CI gate: nonzero exit when the security gate fails
bun run scripts/eval-pr.ts --pr 123 --fail-on-gate
```

Manifest defaults to `~/.run-eval/manifest.jsonl` (override with `RUN_EVAL_STATE_DIR`).

## How it's wired into the AFK flow

Configured in [`../hooks/hooks.json`](../hooks/hooks.json):

- **Capture** (`hooks/capture-run.sh` → `scripts/capture-run.ts`) runs on **both**
  the top-level `Stop` event (headless `afk.sh`, Runner is top-level) and the
  `afk-task-runner` `SubagentStop` event (`afk-issue`, Runner is a sub-agent). On
  each Runner finish it links PR# → transcript in the manifest. It is exit-0 by
  design, so a missing `bun` would silently no-op — the wrapper logs a health line
  to `${RUN_EVAL_STATE_DIR:-~/.run-eval}/capture.log` so that's visible.
- **Evaluate** (`hooks/run-evaluator.sh` → `scripts/eval-pr.ts --publish`) runs on
  the `code-reviewer` `SubagentStop` event, **after** `code-reviewer-push.sh` has
  pushed the review fixes. It resolves PR#/repo from the reviewer's worktree and
  publishes an **advisory** Scorecard. It never passes `--fail-on-gate` and always
  exits 0, so it cannot block an agent; logs to `${RUN_EVAL_STATE_DIR:-~/.run-eval}/evaluator.log`.

The headless `afk.sh` path has **no Reviewer step**, so there is no automatic
Evaluator trigger there yet — run `eval-pr.ts --pr <n> --repo <owner/repo>` manually
until that path grows a review/eval stage.

To turn the security dimension into an actual merge gate, make `eval/security` a
**required** status check in branch protection. It ships **advisory-only** (status
posted but not required) for the first rollout.

## Graduation

Lives here for now. The analyzer is expected to eventually graduate into a
`pe-ai-skills-hooks` plugin (sibling to skill-vetter, reusing its Anthropic SDK +
structured-output harness for the LLM judge), with the capture hooks staying in
`code-skills`. That cross-repo split is deferred — see ADR-0001 consequences.
