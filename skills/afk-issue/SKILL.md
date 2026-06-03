---
name: afk-issue
description: Implement ONE GitHub issue end-to-end with the afk-task-runner, then the code-reviewer, opening a PR (default base main, override with a branch). Orchestration glue for a single targeted issue — use when the user says "afk issue #N", "implement #N and review it", "run the afk runner on issue N", "build and review issue N", or wants one locked-design issue built + reviewed as a PR. For MULTIPLE issues into an integration branch, use feature-branch-fan-in instead.
argument-hint: <issue-number> [base-branch]
---

# afk-issue

Single-issue sibling of `feature-branch-fan-in`: one targeted issue → `afk-task-runner` → `code-reviewer` → a reviewed PR. **Orchestration glue, not a reimplementation** — it chains agents/skills you already have and relies on the existing hooks. Do not re-grill the design or re-write the issue here (upstream: `grill-with-docs`, `to-issues`).

`$ARGUMENTS` = `<issue-number> [base-branch]`. Base defaults to `main`.

## Why a skill at all (vs just spawning the runner)

`afk-task-runner` is written to **select the next queue task**, not to take a target. Left to its defaults it may pick a different issue and defaults its PR toward main. This skill (a) pins it to issue #N, (b) sets the PR base correctly, (c) sequences the reviewer against the runner's worktree, and (d) cleans up — leaning on the hooks rather than duplicating them.

## What the hooks already do (don't re-implement)

- On `afk-task-runner` stop → `afk-handoff.sh` writes `.claude/state/issue-N.json` (`branch`, `worktree`, `pr`, `last_sha`) and posts a PR comment.
- `code-reviewer` reads that state file and `cd`s into the runner's **worktree** to review (it does NOT `gh pr checkout`).
- On `code-reviewer` stop → `code-reviewer-push.sh` pushes the `RALPH: Review -` commits so the PR updates.

## Parameters — resolve first, never hardcode

| Param         | Source                                                       |
| ------------- | ------------------------------------------------------------ |
| issue number  | `$ARGUMENTS` (first token)                                   |
| base branch   | `$ARGUMENTS` (second token); default `main`                  |
| owner/repo    | `gh repo view --json nameWithOwner -q .nameWithOwner`        |
| gh account    | memory or CLAUDE.md (account routing per org); ask if unknown |
| child branch  | `<type>/<N>-<slug>` from the issue title (must match the branch-name hook: `feat\|fix\|chore\|refactor\|perf\|docs\|test`/`<N>`-…) |

## Preconditions

- [ ] Issue #N exists and its design is **locked** (a "design locked" comment, plus `CONTEXT.md` / relevant ADR on the base branch). If not locked → stop, point at `grill-with-docs`.
- [ ] If base ≠ `main`, that branch is **pushed to origin** (a PR can't target a base that isn't on origin).
- [ ] Correct gh account active for the org: `gh auth switch -u <account>`.

## Pipeline

1. **Spawn `afk-task-runner`** (worktree isolation) with the targeted prompt below. It implements issue #N via TDD, runs the feedback loop, commits, and opens the PR. Its stop fires `afk-handoff.sh` → `issue-N.json`.
2. **Verify the PR** points the right way: `gh pr view <n> --json baseRefName,headRefName` → base = `<base>`, head = `<child-branch>`.
3. **Spawn `code-reviewer`** with issue #N + title (template below). It reads `issue-N.json`, `cd`s into the runner's worktree, reviews against locked intent + correctness, fixes, and commits `RALPH: Review -`. Its stop fires `code-reviewer-push.sh` → PR updates.
4. **Report**: PR URL, reviewer verdict (APPROVE / CHANGES MADE / BLOCKED-needs-human), final test result.
5. **Clean up the worktree** (AFTER review, not before — the reviewer reused it): `git worktree remove --force <worktree-from-issue-N.json>` then `git worktree prune`.

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
> Branch + PR: your isolated worktree is branched from `<base>`. Work on child
> branch `<child-branch>` (format `<type>/N-<slug>`). Open the PR with
> **base = `<base>`** and head = `<child-branch>`. PR body: "<Closes|Addresses> #N"
> (per the base). Do NOT close or modify the issue. Report the PR URL, your
> worktree path, and the exact test result.

## code-reviewer prompt template

> Review the work for GitHub issue #N — "<title>" — in <owner>/<repo>.
> `gh auth switch -u <account>` first. Locate the branch/worktree via
> `.claude/state/issue-N.json` (the `branch` + `worktree` fields) and `cd` there —
> do NOT `gh pr checkout`.
>
> Review against the LOCKED intent AND correctness: read the issue's "design
> locked" comment, `CONTEXT.md` <entry>, and the ADR. <List the high-value,
> design-specific checks most likely to be subtly wrong.>
>
> Fix issues + write missing tests. Commit to the branch with messages prefixed
> `RALPH: Review - ` (the push hook ships them). Feedback loop must pass after
> fixes. Return severity-tagged findings, commit SHAs, final test result, and a
> verdict (APPROVE / CHANGES MADE / BLOCKED-needs-human).

## When NOT to use this skill

- **Multiple issues** → `feature-branch-fan-in` (integration branch + consolidated PR).
- **Design not locked** → `grill-with-docs` first.
- **No issue yet** → `to-issues` first.
