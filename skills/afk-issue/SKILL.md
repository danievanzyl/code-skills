---
name: afk-issue
description: Implement ONE GitHub issue end-to-end with the afk-task-runner, then the code-reviewer, opening a PR (default base main, override with a branch). Orchestration glue for a single targeted issue — use when the user says "afk issue #N", "implement #N and review it", "run the afk runner on issue N", "build and review issue N", or wants one locked-design issue built + reviewed as a PR. For MULTIPLE issues into an integration branch, use feature-branch-fan-in instead. For herdr-pane observability + mid-run intervention on a single issue, use afk-issue-herdr instead.
argument-hint: <issue-number> [base-branch]
---

# afk-issue

Single-issue sibling of `feature-branch-fan-in`: one targeted issue → `afk-task-runner` → `code-reviewer` → a reviewed PR. **Orchestration glue, not a reimplementation** — it chains agents/skills you already have. Do not re-grill the design or re-write the issue here (upstream: `grill-with-docs`, `to-issues`).

`$ARGUMENTS` = `<issue-number> [base-branch]`. Base defaults to `main`.

## Why a skill at all (vs just spawning the runner)

`afk-task-runner` is written to **select the next queue task**, not to take a target. Left to its defaults it may pick a different issue and defaults its PR toward main. This skill (a) pins it to issue #N, (b) sets the PR base correctly, (c) sequences an isolated reviewer against the PR, and (d) cleans up both worktrees.

## Correctness rides on explicit data-flow, not hook state

A worktree-isolated subagent runs on a **harness-named branch** (`agent-<id>`), so nothing reliable can be reconstructed from git or a state file after the fact. Therefore:

- The runner **returns** its PR number, head branch, worktree path, and test result. You (the orchestrator) hold these and pass them forward — verify with `gh`, never reconstruct from a state file.
- The hooks are **audit-only / mechanical**, not a data channel: on runner stop `afk-handoff.sh` posts a completion comment to the PR (it writes **no** state file); on reviewer stop `code-reviewer-push.sh` pushes the reviewer's `RALPH:` commits from its own worktree.

## Parameters — resolve first, never hardcode

| Param             | Source                                                       |
| ----------------- | ------------------------------------------------------------ |
| issue number      | `$ARGUMENTS` (first token)                                   |
| base branch       | `$ARGUMENTS` (second token); default `main`                  |
| owner/repo        | `gh repo view --json nameWithOwner -q .nameWithOwner`        |
| gh account        | memory or CLAUDE.md (account routing per org); ask if unknown |
| PR# + head branch | the runner's **return value**, verified via `gh pr view` — NOT assumed from a branch-naming convention |

## Preflight — fail fast, abort on a missing contract

Hard-check ALL of the following before spawning anything. If any fails, **stop and report** what's missing — do not proceed:

- [ ] Issue #N **exists**: `gh issue view N --repo <owner>/<repo>`.
- [ ] Design is **locked**: a "design locked" comment on the issue, plus `CONTEXT.md` / the relevant ADR on the base branch. If not locked → stop, point at `grill-with-docs`.
- [ ] Base branch is **on origin** (a PR can't target a base that isn't pushed). `main` is a given; for any other base verify `git ls-remote --exit-code --heads origin <base>`.
- [ ] Correct **gh account** active for the org: `gh auth switch -u <account>`.

`CODING_STANDARDS.md` is **soft** — the reviewer applies it if present, else general standards. Its absence is not a preflight failure.

## Pipeline

1. **Spawn `afk-task-runner`** (worktree isolation) with the targeted prompt below. It implements issue #N via TDD, runs the feedback loop, commits, and opens the PR. Capture its **return value**: PR#, head branch, worktree path, test result.
2. **Verify the PR** points the right way: `gh pr view <n> --json baseRefName,headRefName` → base = `<base>`, head = the returned branch. If the runner opened no PR, stop and report.
3. **Free the runner's worktree** — BEFORE review, so the reviewer's `gh pr checkout` doesn't hit "branch already checked out": `git worktree remove --force <runner-worktree>` then `git worktree prune`. The branch is safe on origin (the PR is pushed).
4. **Spawn `code-reviewer`** (worktree isolation) with the PR#/branch/issue (template below). It runs `gh pr checkout <n>` in its own worktree, reviews against locked intent + correctness, fixes, and commits `RALPH: Review -`. Its stop fires `code-reviewer-push.sh` → PR updates.
5. **Clean up the reviewer's worktree** (AFTER review): `git worktree remove --force <reviewer-worktree>` then `git worktree prune`.
6. **Report**: PR URL, reviewer verdict (APPROVE / CHANGES MADE / BLOCKED-needs-human), final test result.

Default: **leave the PR open for a human merge** (the PR-to-main is the review gate). Merge only on explicit request: `gh pr merge <n> --squash --delete-branch`.

## Closes vs Addresses (base-dependent)

- base = `main` → PR body **`Closes #N`** (GitHub auto-closes the issue on merge to the default branch).
- base = a non-default branch → PR body **`Addresses #N`** (it will NOT auto-close until that branch reaches main). Say so in the report.

## afk-task-runner prompt template

> Implement GitHub issue #N ONLY ("<title>") in <owner>/<repo>. Work on issue #N
> ONLY — do NOT select a different issue from the queue, do NOT touch other
> issues' scope. Use gh account `<account>` — run `gh auth switch -u <account>` first.
>
> The design is ALREADY LOCKED — do not re-design or re-grill. Read first:
> (1) `gh issue view N --repo <owner>/<repo> --comments` → the "design locked"
> comment is authoritative; (2) `CONTEXT.md` → <relevant entry>; (3)
> `docs/adr/<NNNN>.md`.
>
> <Paste the locked design summary here.>
>
> TDD. Feedback loop must pass before the PR (use `.claude/state/feedback-cmds.json`
> if present, else infer: go → `go vet ./... && go test -race ./...`; node → the
> project's test + typecheck; etc.).
>
> Branch + PR: your isolated worktree is branched from `<base>`. Open the PR with
> **base = `<base>`** and head = your worktree's branch. PR body:
> "<Closes|Addresses> #N" (per the base). Do NOT close or modify the issue.
>
> RETURN (the orchestrator depends on these — be exact): the PR number + URL, the
> head branch name, your worktree path, and the exact test result.

## code-reviewer prompt template

> Review open PR #<n> in <owner>/<repo>. Branch: `<head-branch>`. Issue: #N —
> "<title>". PR base: `<base>`.
>
> Setup: `gh auth switch -u <account>`, then `gh pr checkout <n> --repo <owner>/<repo>`
> — you run worktree-isolated, so check the PR out into your OWN worktree; do NOT
> look for a state file or another agent's worktree.
>
> Review against the LOCKED intent AND correctness: read the issue's "design
> locked" comment, `CONTEXT.md` <entry>, and the ADR. <List the high-value,
> design-specific checks most likely to be subtly wrong.>
>
> Fix issues + write missing tests. Commit with messages prefixed `RALPH: Review - `
> and push so the PR updates (the push hook also ships them). Feedback loop must
> pass after fixes. Return severity-tagged findings, commit SHAs, final test
> result, and a verdict (APPROVE / CHANGES MADE / BLOCKED-needs-human).

## When NOT to use this skill

- **Multiple issues** → `feature-branch-fan-in` (integration branch + consolidated PR).
- **Want herdr-pane observability/mid-run intervention** → `afk-issue-herdr` (same pipeline, herdr panes instead of in-process subagents).
- **Design not locked** → `grill-with-docs` first.
- **No issue yet** → `to-issues` first.
