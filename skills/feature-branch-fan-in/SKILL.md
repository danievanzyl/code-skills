---
name: feature-branch-fan-in
description: Drives a feature-branch fan-in — implements a set of ready-for-agent GitHub issues whose design is already locked by spawning the afk-task-runner per issue (each PR targeting a feature/integration branch, NOT main), then the code-reviewer on each PR, squash-merging each into the feature branch, and finally opening one consolidated PR to main. Use when the user has a pushed feature branch plus multiple issues to fan out, says "fan out these issues", "run the AFK queue into a feature branch", "implement #X and #Y under a feature branch with review", or wants several locked-design issues built + reviewed + merged into one integration branch then PR'd to main as a unit.
---

# Feature-branch fan-in

Orchestration glue, not a reimplementation. It chains agents/skills you already
have — `afk-task-runner`, `code-reviewer` (or `/review`), `git-worktree` — and
contributes the wiring + the seven gotchas below. Do not re-grill designs or
re-write issues here; those are upstream (`grill-with-docs`, `to-issues`).

## Preconditions (verify before starting)

- [ ] The design is **locked** — each issue carries the resolved decisions (a "design locked" comment, plus `CONTEXT.md` / relevant ADR on the branch).
- [ ] Issues are labelled ready-for-agent (the project's AFK label).
- [ ] A **feature/integration branch** exists and is **pushed to origin** (PRs can't target a base that isn't on origin).
- [ ] The correct gh account is active for the target org (gotcha 7).

## Parameters — resolve these first, never hardcode

| Param | Source |
|-------|--------|
| feature branch | the user / current branch |
| gh account | memory or CLAUDE.md (e.g. account routing per org) |
| ready-for-agent label | memory or CLAUDE.md; ask if unknown |
| issue list + order | the user; else `gh issue list --label <label>` |

## Order decision (gotcha 5)

Inspect whether the issues touch overlapping files (`gh issue view`, or grep the
file pointers in each issue). **Overlapping ⇒ sequential with merge-between**
(each agent builds on the prior). **Independent ⇒ may run in parallel.** When
unsure, default to sequential — it's slower but never conflicts. State the
choice and why.

## The loop (per issue)

1. **Spawn `afk-task-runner`** (worktree isolation) to implement ONE issue via TDD. In the prompt: the locked-design context (gotcha 4), child branch name, and PR mechanics — `gh pr create --base <feature-branch>` (gotcha 1), body says "Addresses #N" NOT "Closes #N" (gotcha 2), do not close the issue. Require `go vet` / tests green before PR.
2. **Verify** the PR base = feature branch and head = the child branch (`gh pr view <n> --json baseRefName,headRefName`).
3. **Free the branch** (gotcha 3): the runner's isolated worktree still holds the child branch. `git worktree remove --force <path>` (+ `git worktree prune`) before the reviewer can `gh pr checkout` it.
4. **Spawn `code-reviewer`** (worktree isolation) against the PR, with the same locked-design context (gotcha 4) so it reviews for faithfulness, not just generic quality. It fixes issues, commits `RALPH: Review - …`, and pushes so the PR updates.
5. **Squash-merge** into the feature branch (gotcha 6): `gh pr merge <n> --squash --delete-branch`. Sync local: `git pull --ff-only origin <feature-branch>`.
6. If sequential, the next issue's runner now branches off the updated feature branch automatically.

## Finish

- [ ] Integrated build/test on the feature branch (the squash-merges combine cleanly).
- [ ] Open ONE consolidated PR `<feature-branch> → main`, body `Closes #N` for each issue (they auto-close at the main merge, per gotcha 2).
- [ ] Surface any cross-repo / deploy coordination notes carried from grilling.

## The seven gotchas + agent-prompt templates

See [REFERENCE.md](REFERENCE.md) — the why behind each gotcha (so you don't
"simplify" them away) and copy-paste prompt templates for both agents.
