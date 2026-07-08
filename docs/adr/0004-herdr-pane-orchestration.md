---
status: accepted
refs: "#52"
---

# afk-issue-herdr: terminal-hosted agent orchestration via herdr panes

## Context

[ADR-0002](0002-afk-issue-explicit-data-flow.md) established that an in-process `isolation: worktree` subagent has **no reliable git-reconstructable state**, so correctness rides on the subagent's **return value** — the Runner returns its PR#, branch, worktree path, and test result, and the Orchestrator holds and forwards it. That whole model assumes an in-process subagent that *can* return a value and whose lifecycle fires `SubagentStop` in the Orchestrator's process.

`afk-issue-herdr` (issue #52) runs each agent as a **full Claude Code session inside its own herdr pane** instead of as an in-process subagent. This is motivated by observability, mid-run human intervention, and orchestrator↔agent messaging — none of which the opaque in-process Task path offers. But it breaks two assumptions ADR-0002 relied on:

1. **A pane-hosted agent has no return value.** It is a separate process attached to a terminal. The only "output" is text on a screen — and scraping structured data out of a terminal is fragile (ANSI, soft-wrapping, scrollback, the agent's own prose polluting matches).

2. **A pane-hosted agent is a top-level process, not a subagent of the Orchestrator.** Its termination fires a top-level `Stop` in *its own* process — **never** a `SubagentStop` in the Orchestrator's process. So the existing eval wiring (`code-reviewer` `SubagentStop` → `run-evaluator.sh`, and the `capture-run.sh` `SubagentStop` linker) does not fire for herdr agents.

A naive port — "spawn the same agents, reuse the same hooks" — silently produces no evaluation and no reliable data hand-off.

## Decision

Correctness moves off both the return-value channel and the `SubagentStop`-triggered eval, onto Orchestrator-defined explicit contracts:

1. **Report file, not return value.** Each agent writes a structured report — `{pr, branch, transcript_path, test_result, verdict}` — to an **Orchestrator-designated path outside the worktree** (`~/.afk-herdr/<N>/{runner,reviewer}-report.json`). Outside the tree so the report never dirties the Runner's working tree or breaks the Reviewer's clean-tree check. The agent self-reports its own transcript path. Terminal reads (`pane read`) are a human observability aid, never the data channel.

2. **Sentinel signal, status backstop.** Each agent's final terminal action prints a rare sentinel — `<<<AFK_WORK_DONE>>>` or `<<<AFK_WORK_BLOCKED>>>` (rare token, absent from the launching command, unlikely to appear in prose). The Orchestrator gates on `wait output --match "<<<AFK_WORK_(DONE|BLOCKED)>>>" --regex` (a deterministic emitted string), with `agent_status` polling as a backstop. `wait agent-status` alone is demoted to corroboration — it timed out in live testing even when the target state was reached. `done` with no report file ⇒ failure.

3. **Orchestrator-driven, per-role eval.** Because `SubagentStop` never fires for pane agents, the Orchestrator invokes `eval-pr.ts` itself, in two passes: **after the Runner finishes** (`--transcript <runner>`, scoring the Runner Trajectory), and **again after the Reviewer finishes** (`--transcript <runner> --reviewer-transcript <reviewer>`, which additively merges the Reviewer Trajectory into a single combined Scorecard — the CLI produces one Scorecard per PR, not two independent ones). This per-role invocation is what the versioned Rubric anticipates but the in-process single-trigger path never produced. Top-level `Stop` → `capture-run.sh` still fires per-pane and harmlessly links PR→transcript; there is no double-eval.

4. **Shared worktree, Orchestrator-owned.** The Orchestrator owns the worktree lifecycle on a meaningful branch (`afk/N-<slug>`), and Runner + Reviewer **share** it. Because the branch is already checked out there, the Reviewer **skips `gh pr checkout` entirely** — eliminating ADR-0002's "free the worktree before review" step and `feature-branch-fan-in`'s "branch already checked out" gotcha. The Reviewer asserts a clean tree and `HEAD == origin PR head` before reviewing. Runner and Reviewer remain **distinct panes/sessions** (not one reused) — forced by per-role eval, since one session = one transcript.

5. **HITL keeps the session alive.** On `<<<AFK_WORK_BLOCKED>>>` or `agent_status: blocked`, the Orchestrator focuses the pane, fires a herdr notification, and **keeps waiting** for `<<<AFK_WORK_DONE>>>` — the human unblocks in-pane and the pipeline resumes. The live session is the whole point; it is never abandoned on a block.

6. **Two-phase, id-explicit teardown.** Phase 1 (automatic) leaves the PR, tab, and worktree in place for inspection. Phase 2 (explicit) closes the tab **by its tracked id**, *then* removes the worktree — a worktree cannot be removed while a pane's cwd is still inside it. Child ids are tracked explicitly; the Orchestrator never blanket-closes non-focused panes and never assumes ownership of the human's focused pane.

## Consequences

- `afk-issue-herdr` ships as a **separate skill** (sibling of `afk-issue`), not a `--herdr` flag — the data channel, worktree sharing, eval trigger, and teardown all diverge from the in-process path, and a flag would turn `afk-issue`'s body into a per-step conditional thicket.
- The skill stays **MIT** while depending on the vendored **AGPL** `herdr` CLI: it only *invokes* documented commands, copying no AGPL code (see [ADR-0003](0003-agpl-skill-in-mit-plugin.md)).
- The multi-issue queue/concurrency variant (herdr sibling of `feature-branch-fan-in`) is **deferred** until the single-issue mechanics are proven — tracked in a follow-up issue.
- A **new domain role, Orchestrator**, is added to `CONTEXT.md` — previously implicit in `afk-issue`/`feature-branch-fan-in` ("You (the orchestrator)"), now a first-class role because the herdr variant makes it a distinct, long-lived hub.
- The design surfaced that the vendored `skills/herdr/SKILL.md` is **stale** vs the real binary (missing `pane split --cwd`, `pane rename`, `notification`, `worktree` subcommands, and the `agent` control API) — tracked in a follow-up; the design assumes the real binary's capabilities.
