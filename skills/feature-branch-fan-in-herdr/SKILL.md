---
name: feature-branch-fan-in-herdr
description: Herdr-native sibling of feature-branch-fan-in — drives a sequential queue of ready-for-agent GitHub issues, each through the full afk-issue-herdr pipeline (orchestrator → runner → reviewer, each a herdr pane agent) targeting a feature/integration branch, squash-merging each into the feature branch before starting the next, then opens one consolidated PR to main. Use when the user says "fan out these issues in herdr", "run the AFK queue into a feature branch with herdr", "queue issues #X #Y #Z onto <branch> in herdr", or wants live observability + mid-run intervention across a multi-issue fan-in. v1 is sequential-only — cross-issue concurrency is a deferred v2 (#61). For the in-process (no herdr) version use feature-branch-fan-in; for a single issue use afk-issue-herdr.
argument-hint: <feature-branch> [issue-number...]
---

# feature-branch-fan-in-herdr

Herdr-native sibling of `feature-branch-fan-in`, as `afk-issue-herdr` is to `afk-issue`. **Orchestration glue, not a reimplementation** — it composes both parents by reference and contributes only the deltas below; it duplicates neither parent's contracts. Design locked in issue #53 / [ADR-0005](../../docs/adr/0005-fan-in-herdr-sequential-queue.md) — do not re-grill it. **v1 is sequential-only**; cross-issue concurrency and a configurable cap are deferred to v2 (#61) — see "Explicitly deferred to v2" below.

`$ARGUMENTS` = `<feature-branch> [issue-number...]`. If issue numbers are given, that order wins outright (see "Order", below).

## Composition

- **Per-issue engine = `afk-issue-herdr`** (#52 / [ADR-0004](../../docs/adr/0004-herdr-pane-orchestration.md)): panes, worktree-first isolation, report-file + sentinel data channel, per-role eval, HITL, teardown, model/permission launch policy. Invoked once per issue with the feature branch as its `[base-branch]` arg — this skill does not restate any of that mechanic, only the deltas layered on top. Herdr agent naming (`runner-<tab_id>`/`reviewer-<tab_id>`, #73) is engine-owned and tab-scoped — a v2 (#61) cross-issue-concurrency author must not reintroduce bare `runner`/`reviewer` names.
- **Outer loop + finish = `feature-branch-fan-in`**: the sequential-queue shape, the seven gotchas, and the consolidated-PR finish. This skill does not restate the gotchas' rationale — see [`feature-branch-fan-in/REFERENCE.md`](../feature-branch-fan-in/REFERENCE.md) for why each exists.

## Roles (see `CONTEXT.md`)

Same three roles as `afk-issue-herdr` — you are the **Orchestrator** for the whole queue, not just one issue: you propose + confirm order, drive one pipeline at a time to completion, own the dedicated feature-branch worktree, squash-merge, sync, teardown per issue, halt-and-ask on terminal failure, and open the consolidated PR. `afk-task-runner` is the Runner, `code-reviewer` is the Reviewer, for every issue in the queue.

## Precondition — herdr + a pre-existing feature branch

- `HERDR_ENV=1` — same check as `afk-issue-herdr`; if unset, stop and use `feature-branch-fan-in` instead.
- **Feature branch must pre-exist and be pushed** — `git ls-remote --exit-code --heads origin <feature-branch>`. Abort if missing. **No auto-create.**

## Parameters — resolve first, never hardcode

| Param                      | Source                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| feature branch              | `$ARGUMENTS` (first token)                                                                   |
| issue list                  | `$ARGUMENTS` (remaining tokens) if given (operator order wins); else `gh issue list --label <ready-for-agent label>` |
| owner/repo                  | `gh repo view --json nameWithOwner -q .nameWithOwner`                                        |
| gh account                  | memory or `CLAUDE.md`; ask if unknown (gotcha 7)                                             |
| ready-for-agent label       | memory or `CLAUDE.md`; ask if unknown                                                        |
| per-issue params            | resolved exactly per `afk-issue-herdr`'s own Parameters table, for each issue in turn, with `base branch = <feature-branch>` |
| orchestrator worktree path  | `~/.herdr/worktrees/<repo>/<feature-branch>` (canonical layout, no pane — see below)          |

## Preflight

- [ ] Precondition above (`HERDR_ENV=1`, feature branch on origin).
- [ ] Design is **locked**: issue #53's "🔒 Design locked" comment + ADR-0005 on the base branch — this skill's own design. Each queued issue additionally carries its own "design locked" comment, checked per-issue by `afk-issue-herdr`'s own preflight.
- [ ] Correct **gh account** active: `gh auth switch -u <account>`.
- [ ] Every queued issue exists and is labelled ready-for-agent: `gh issue view <n> --repo <owner>/<repo>`.

## Order — proposed, human-confirmed

`feature-branch-fan-in`'s order decision picks sequential-vs-parallel per file overlap (gotcha 5). That choice is **subsumed** here — v1 makes every issue sequential-with-merge-between unconditionally (see "The queue", below) — so the only decision left is *which* order, and because each runner branches off the *accumulated* feature-branch state, order is load-bearing for correctness (a foundational issue must merge before its consumer).

- **Operator-supplied order wins outright** — the issue numbers as given in `$ARGUMENTS`, no inspection needed.
- **Otherwise, propose then confirm:** inspect each issue (`gh issue view <n> --repo <owner>/<repo>`) for dependency signals ("Blocked by #N", "Depends on #N") and file-pointer overlap (same method as the parent's gotcha-5 inspection), derive a topological order, present it to the human with the reasoning, and get explicit confirmation **before the first runner starts**.
- **Never a silent issue-number fallback** — an unconfirmed default order risks basing a consumer issue's runner on a feature branch that doesn't yet contain its dependency.

## Dedicated Orchestrator feature-branch worktree

Created once in preflight, before the first issue's pipeline starts; kept alive for the whole queue's life (removed only at Finish).

- **Plain `git worktree add <path> <feature-branch>`** — deliberately **not** `herdr worktree create`. `afk-issue-herdr`'s worktree-first mechanic (Isolation section) exists to dodge idle-workspace reaping between worktree creation and pinning a pane agent to it; this worktree never gets a pane agent at all, so herdr never learns about it as a workspace and there is no idle-reap risk to dodge.
- Path: `~/.herdr/worktrees/<repo>/<feature-branch>` (same canonical `<repo>/<branch>` layout `afk-issue-herdr` uses for its own worktrees — distinct branch name, no collision).
- **Used for:** the post-merge sync (`git pull --ff-only origin <feature-branch>`, "The queue" step 4 below) and the **required** final integrated build/test before the consolidated PR (Finish, below) — squash-merges can interact even when every sub-PR was individually reviewed and CI-green.

## The queue — sequential-only, merge-between, unconditionally

For each issue in the confirmed order:

1. **Run the full `afk-issue-herdr` pipeline** for this issue — its SKILL.md steps 1–11, unmodified mechanic (preflight, topology, worktree-first isolation, agent control, data channel, completion detection, HITL) — equivalent to invoking it as `afk-issue-herdr <issue-number> <feature-branch>` (feature branch as `[base-branch]`). This satisfies gotcha 1 (sub-PR base = feature branch) by construction via the arg, and gotcha 4 (locked design into both agents) by inheritance.
   - **Delta (gotcha 2):** the Runner prompt overrides `afk-issue-herdr`'s reused, `Closes`-oriented `afk-task-runner` template — PR body says **"Addresses #N"**, never "Closes #N"; the Runner does not close the issue. `Closes #N` appears only on the consolidated PR (Finish, below).
   - **Delta:** also pass this queue's own locked-design pointer (issue #53 / ADR-0005) into both the Runner and Reviewer prompts alongside the sub-issue's own locked design — so both agents know they're building one issue *within* a fan-in, not a standalone PR to main.
2. **On Reviewer done**, before merging, confirm two things beyond the reported verdict:
   - `gh pr checks <pr>` is green.
   - **The reviewer has pushed its own commits** — `git log -1` in the shared worktree shows a `RALPH: Review -` commit at `HEAD`, matching `gh pr view <pr> --json headRefOid -q .headRefOid`. This is the herdr-native constraint beyond the seven gotchas: `code-reviewer-push.sh` only fires on the in-process `code-reviewer` `SubagentStop` event, which never fires for a pane agent (ADR-0004) — so the Reviewer's own prompt delta (`afk-issue-herdr`'s "Deltas from the in-process prompt templates") already has it `git push` itself, and this step verifies that actually landed before the merge captures it.
   - If the verdict is `BLOCKED-needs-human`, or CI is red and unfixable, or the push didn't land — this is a **terminal failure**: go to "Halt-and-ask", not to step 3.
3. **Squash-merge** (gotcha 6 — queue-owned, overrides `afk-issue-herdr`'s Phase-1 default of leaving the sub-PR open): `gh pr merge <pr> --squash --delete-branch`.
4. **Sync** the dedicated Orchestrator worktree: `git pull --ff-only origin <feature-branch>` — lands the accumulated state the *next* issue's runner branches off of.
5. **Teardown this issue immediately** — a delta from `afk-issue-herdr`'s default of leaving teardown to an explicit human wrap-up (its Phase 2): run that same Phase 2 recipe **now, automatically**, right after a successful merge — `herdr worktree remove --workspace <workspace-id> --force` (one atomic call: closes tab + panes + workspace, removes + prunes the worktree; branch stays on origin). Only ever the workspace this issue's pipeline created, by its tracked id. Keeps the herdr UI legible across a long queue — only the active pipeline's workspace stays live.
6. Move to the next issue in the order; its `afk-issue-herdr` pipeline branches off the just-synced feature branch (step 4).

## Halt-and-ask on terminal failure — never auto-skip

- **Blocked (non-terminal):** inherit `afk-issue-herdr`'s keep-alive-and-wait exactly (its "HITL / blocked handling" section) — the queue naturally pauses here since at most one pipeline is ever active.
- **Terminal failure** — the human declines to unblock, the Reviewer's verdict is `BLOCKED-needs-human`, or tests are unfixably red: **halt the queue.** Do not tear down, do not skip ahead automatically. Leave the failed issue's tab + worktree alive for inspection. Report to the human: which issues already merged (with PR links), which issue halted and why. Ask explicitly, one of:
  - **intervene** in the live pane, then **resume** the queue from this issue;
  - **explicitly skip** this issue and continue to the next — state the risk out loud first: downstream issues in the order will now be based on a feature branch missing this issue's work;
  - **stop** now and open a **partial** consolidated PR covering only the issues merged so far (Finish, below, scoped to that subset).

  Silently skipping is never an option — it would base downstream issues on a feature branch missing the failed issue's work with no record of the gap.

## Finish — integrated build/test, one consolidated PR

- [ ] In the dedicated Orchestrator worktree (already synced through every merge): run the repo's feedback loop / integrated build+test. **Required**, not optional — squash-merges can interact even when every sub-PR was individually reviewed and CI-green.
- [ ] Open **one** PR `<feature-branch> → main`, body `Closes #N` for each merged issue (gotcha 2's counterpart — `Closes` belongs only here).
- [ ] Remove the dedicated Orchestrator worktree: `git worktree remove --force <path>` + `git worktree prune` (no herdr workspace was ever attached to it — see above). Then close out any kept-alive failed-issue tabs the human has finished inspecting, via the same per-issue Phase 2 recipe, by their tracked workspace ids.

## Evaluation — per-issue, per-role only; no queue-level rollup

Each issue is scored exactly per `afk-issue-herdr`'s own Evaluation section, unmodified — one Runner Scorecard and one full-Trajectory Scorecard per issue, published from within that issue's own pipeline run (step 1, above). The consolidated PR → main is **not** a Run — no agent Trajectory produced it, the Orchestrator merges it directly — so it is not scored. Queue-level rollup across issues is deferred (see below).

## Seven-gotcha reconciliation

| # | `feature-branch-fan-in` gotcha | v1 disposition |
| - | ------------------------------- | --------------- |
| 1 | Sub-PR base = feature branch | Survives via mechanism swap — the feature branch is passed as `afk-issue-herdr`'s `[base-branch]` arg. |
| 2 | "Addresses #N", never "Closes #N" on sub-PRs | Survives — key prompt delta ("The queue" step 1); `Closes #N` only on the consolidated PR. |
| 3 | Free runner's worktree before reviewer checkout | Killed by construction — inherited from `afk-issue-herdr`, which shares one worktree runner↔reviewer and skips `gh pr checkout` entirely. |
| 4 | Pass locked design into both agents | Survives, inherited, plus this queue's own design pointer layered on top. |
| 5 | Sequential-with-merge-between for overlapping files | Subsumed — v1 makes *every* issue sequential-with-merge-between regardless of overlap. Order still matters (see "Order"). |
| 6 | Squash-merge sub-PRs | Survives — queue-owned, **overrides** `afk-issue-herdr`'s Phase-1 default of leaving the PR open ("The queue" step 3). |
| 7 | Assert gh account up front | Survives, inherited — Preflight, plus each pane agent re-asserts (it runs its own `gh`). |

Plus the herdr-native constraint beyond the seven: **squash-merge waits until the pane-hosted Reviewer has pushed** its own `RALPH: Review -` commits ("The queue" step 2) — `code-reviewer-push.sh` is dead for pane agents (ADR-0004), so the merge must capture the reviewed state, not the pre-review state.

## Explicitly deferred to v2 (#61) — do not implement

- **Cross-issue concurrency + a configurable cap.** Its payoff is wall-clock, not correctness; watching N concurrent pipelines means round-robin polling N `agent_status` loops instead of `afk-issue-herdr`'s one proven blocking loop — a new mechanic this skill does not add.
- **Multi-simultaneously-blocked HITL.** v1 has at most one active pipeline, so every HITL notification/focus/report is issue-#-qualified and trivially unambiguous. Don't build disambiguation for a case v1 can't produce.
- **Queue-level Scorecard rollup.** Each issue is scored individually (Evaluation, above); a rollup across issues is a v2 concern.

## When NOT to use this skill

- **Single issue** → `afk-issue-herdr` (no queue, no feature-branch fan-in needed).
- **No herdr session** (`HERDR_ENV` unset) → `feature-branch-fan-in` (in-process, no observability/intervention).
- **Cross-issue concurrency wanted** → not yet built; tracked in #61.
- **Design not locked** → `grill-with-docs` first.
- **No issues yet** → `to-issues` first.
