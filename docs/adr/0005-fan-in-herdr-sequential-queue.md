---
status: accepted
refs: "#53"
---

# feature-branch-fan-in-herdr: a sequential queue over the herdr pipeline

## Context

[ADR-0004](0004-herdr-pane-orchestration.md) established `afk-issue-herdr`: one issue driven `orchestrator → runner → reviewer`, each a **full Claude Code session in its own herdr pane**, with a report-file + sentinel data channel, Orchestrator-driven per-role eval, and two-phase teardown.

Issue #53 asks for the multi-issue sibling — the herdr-native counterpart of `feature-branch-fan-in` (in-process): loop a queue of `ready-for-agent` issues, each through the #52 pipeline, targeting a feature/integration branch, then open **one consolidated PR to main**. #53's acceptance criteria explicitly list **cross-issue concurrency with a cap**.

Two facts shape the design:

1. **The Orchestrator is a single CLI-driven Claude session.** In #52 it watches *one* pipeline via a blocking poll loop (`wait output` + `agent_status`). Watching N concurrent pipelines means interleaving N poll loops by round-robin polling — a new, harder mechanic — plus context growth from tracking N live tabs, pane-ids, and reports at once.
2. **`feature-branch-fan-in` gotcha 5:** issues touching shared files **must** run sequential-with-merge-between; parallelism is only ever legal for verified-independent issues.

## Decision

**v1 is a sequential queue; concurrency is deferred.**

1. **Sequential-only, merge-between.** Drive one full #52 pipeline to completion, squash-merge its sub-PR into the feature branch, sync, then start the next — so each runner branches off the *accumulated* feature-branch state. This kills gotcha 5 unconditionally (every issue is sequential regardless of overlap) and keeps #52's proven single-pipeline poll loop intact untouched. Cross-issue concurrency + cap (the AC's parallel case) is a **v2 follow-up**: its payoff is wall-clock, not correctness, and the herdr value here is observability + HITL across the queue + the consolidated landing.

2. **Reuse by reference, deltas only.** A new skill, `feature-branch-fan-in-herdr`, composes both parents: the per-issue *engine* is #52 (panes, data channel, sentinel, per-role eval, HITL), invoked with the feature branch as its `[base-branch]` arg; the *outer loop + finish* is `feature-branch-fan-in`. It contributes only the deltas and duplicates neither parent's contracts (same discipline #52 uses reusing `afk-issue`'s templates).

3. **Order proposed, human-confirmed.** Because every issue is sequential-with-merge-between, order is load-bearing for correctness (a foundational issue must merge before its consumer). Operator-supplied order wins; otherwise the Orchestrator inspects dependency/overlap and *proposes* an order, confirmed before the first runner starts — overrideable, never a silent issue-number fallback.

4. **Halt-and-ask on terminal failure, never auto-skip.** *Blocked* (non-terminal) inherits #52's keep-alive-and-wait — a sequential queue naturally pauses there. On *terminal* failure (human declines to unblock, reviewer verdict `BLOCKED-needs-human`, unfixable red tests) the queue **halts**, leaves the failed issue's tab live, reports which issues already merged, and asks the human: intervene + resume / explicitly skip / stop and open a partial consolidated PR. Silently skipping would risk basing downstream issues on a feature branch missing the failed issue's work.

5. **Teardown per-issue after merge; failures kept alive.** Diverging from #52's leave-everything-until-explicit-wrap: tear down each issue's tab + worktree immediately after its successful squash-merge (eval has already run and transcripts persist on disk), keeping the herdr UI legible during a long queue — only the active pipeline stays live. **Keep a blocked/failed issue's tab + worktree alive** for human inspection. Teardown order per #52: close the tab *by tracked id*, then remove the worktree.

6. **Dedicated Orchestrator feature-branch worktree.** Created in preflight and kept for the queue's life: post-merge `git pull --ff-only origin <feature>` lands here, and the **required final integrated build/test** runs here before the consolidated PR (squash-merges can interact even when every sub-PR was reviewed + CI-green). Removed only at Phase-2 wrap, alongside any kept-alive failed tabs.

### Seven-gotcha reconciliation

| # | `feature-branch-fan-in` gotcha | v1 disposition |
| - | ------------------------------ | -------------- |
| 1 | Sub-PR base = feature branch | **Survives** via mechanism swap — Orchestrator passes the feature branch as #52's `[base-branch]` arg; the per-issue runner opens its PR with base = feature. |
| 2 | "Addresses #N", never "Closes #N" on sub-PRs | **Survives — key prompt delta.** #52/`afk-issue`'s runner template is main-base/`Closes`-oriented; the queue overrides it to `Addresses #N` + don't-close. `Closes #N` goes only on the consolidated PR. |
| 3 | Free runner's worktree before reviewer checkout | **Killed by construction** — #52 shares one worktree runner↔reviewer and skips `gh pr checkout`. No action. |
| 4 | Pass locked design into BOTH agents | **Survives**, inherited — each issue's runner + reviewer prompts (via #52) carry the locked-design context. |
| 5 | Sequential-with-merge-between for overlapping files | **Subsumed** — v1 makes *every* issue sequential-with-merge-between, satisfying it unconditionally. Order still matters (decision 3). |
| 6 | Squash-merge sub-PRs | **Survives — queue-owned, and overrides #52.** #52 leaves the sub-PR *open* for human merge (Phase-1 default); the queue squash-merges each into the feature branch itself once the reviewer has approved + pushed and CI is green, then syncs. |
| 7 | Assert gh account up front | **Survives**, inherited — #52 preflight asserts it; each pane agent's prompt re-asserts (it runs its own `gh`). |

Plus one herdr-native constraint not in the seven: **squash-merge waits until the pane-hosted reviewer has pushed its own `RALPH: Review -` commits** — the `code-reviewer-push.sh` hook is dead for pane agents (ADR-0004), so the merge must capture the reviewed state, not the pre-review state.

## Consequences

- The AC's **concurrency + cap** and **multi-simultaneously-blocked HITL** items are explicitly scoped to **v2**; v1 satisfies the multi-blocked case trivially (≤ 1 active pipeline). HITL notifications/focus in v1 are issue-#-qualified so a workspace holding the active tab plus kept-alive failed tabs stays unambiguous. Tracked in **#61**.
- **Eval is per-issue, per-role only.** Each issue is a **Run** (`CONTEXT.md`); the consolidated PR → main is **not** a Run (no agent Trajectory produced it — the Orchestrator merges it), so it isn't scored. Queue-level rollup deferred.
- **gotcha 6 overrides #52**: the queue squash-merges each sub-PR itself rather than leaving it open for a human merge — the single most behavior-changing delta vs the single-issue skill.
- **No `CONTEXT.md` change**: the Orchestrator entry already reads "drives a pipeline … for one or more issues," so the queue adds workflow mechanics, not new domain vocabulary.
- Ships as a **separate skill** (sibling of `afk-issue-herdr`, mirroring how `feature-branch-fan-in` is a sibling of `afk-issue`), not a `--queue` flag on #52 — the loop, feature-branch targeting, merge-between, and consolidated finish all diverge from the single-issue path.
- Stays **MIT** while depending on the vendored **AGPL** `herdr` CLI, same posture as [ADR-0003](0003-agpl-skill-in-mit-plugin.md)/[ADR-0004](0004-herdr-pane-orchestration.md): it only *invokes* documented commands.
