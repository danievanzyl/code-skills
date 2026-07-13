---
status: accepted
refs: "#52"
---

# afk-issue-herdr Runner: gh-collected external references over local disk traversal

## Context

The herdr pane Runner ([ADR-0004](0004-herdr-pane-orchestration.md)) explores for context via local `Glob`/`Grep`/`Read`. A **future sandbox** is anticipated that confines the Runner's **filesystem to its own worktree** (no cross-repo/disk traversal) while leaving **network open**. Under that model, the Runner can no longer read *external* reference material (other repos, `~/code` siblings) off local disk — but it can still reach GitHub over the network.

This is scoped to **external, cross-repo reference material only**. The Runner keeps local filesystem access for its own worktree (it must, to implement) — nothing about in-repo reading changes.

## Decision

When the Runner judges an issue needs external references, it **nests `gh-search-researcher` via its own `Task` tool** to collect them from GitHub, instead of traversing local disk.

- **Runner-nested, not Orchestrator-hoisted.** The pane Runner already has `Task` (the permission policy keeps it; `--plugin-dir` loads the plugin so the `gh-search-researcher` agent type resolves) — zero infra change. Coherent under the sandbox because network stays open, so the nested subagent's `gh` calls work.
- **Delivery is inline into context.** The subagent's return value lands in the Runner's session context (ordinary `Task` behaviour). No disk materialisation — this keeps the worktree clean (Reviewer's `git status --porcelain` check) and never writes outside the worktree (sandbox boundary).
- **Return content = excerpts + pointers.** The invocation prompt coerces `gh-search-researcher` to return relevant **code excerpts + URLs + why-relevant**, not its default URL-and-summary research report, so the Runner can implement against the excerpts without re-fetching. This is prompt-level; the shared agent def is untouched.
- **Open-ended, unbounded discovery.** The Runner hands the issue to the subagent, which searches GitHub and decides relevance itself — across **all of GitHub**, no org scoping.
- **Conditional.** Only spawned when the Runner judges the issue benefits from external references; self-contained in-repo work skips it.
- **herdr-only.** Lives as a single clause in the "Runner delta" section of `skills/afk-issue-herdr/SKILL.md`. The in-process `afk-issue` Runner and the shared `agents/afk-task-runner.md` def are **not** changed.

## Considered Options

- **Orchestrator collects up-front and injects into the prompt.** Rejected: the Runner is the sandbox target and network stays open there, so collection survives in-pane; keeping it Runner-side avoids an Orchestrator round-trip.
- **Apply to both variants (grant `Task` to the shared def).** Rejected for now: herdr is the sandbox target; in-process `afk-issue` is not being sandboxed, so the divergence is tolerated (see Consequences).
- **Design-named / org-scoped references.** Rejected in favour of unbounded open-ended discovery (see Consequences).

## Consequences

- **Efficiency-parity break, accepted.** Only the herdr Runner nests the collector; the in-process Runner cannot (its def grants no `Task`). Per `CONTEXT.md`'s Efficiency dimension the two variants' Trajectories are no longer like-for-like. Accepted because in-process is not a sandbox target. Contrast the "Engineer parity caveat" in `afk-issue-herdr`, which requires *both* variants to change together — this decision deliberately does not.
- **Non-deterministic Trajectory.** Open-ended discovery makes the herdr Runner's Trajectory (and Efficiency numbers) vary run-to-run even within herdr.
- **No provenance/licensing gate.** Unbounded GitHub search can feed arbitrary external code into an AFK implementer with no human in the loop. The Reviewer/Evaluator (Security dimension) is the only backstop.
- **Sandbox is still anticipated, not present.** This ships now as prompt guidance ahead of the sandbox landing.
