# 0001 — GitHub-side stacked PRs for PRD aggregation

## Status

Accepted, 2026-05-14.

## Context

A PRD branch aggregates work from multiple GitHub issues. Three plausible shapes for getting that work into the PRD branch and then onto `main`:

1. **GitHub-side stacking.** Each child issue has its own PR targeting the PRD branch. Children get reviewed + merged on GitHub. PRD's own PR targets `main`.
2. **Local consolidation.** Children never get GitHub PRs. They're merged/rebased into the PRD worktree locally. One single PR to `main`. Child branches are invisible to GitHub.
3. **Hybrid.** Children have *draft* PRs (CI visibility), then get closed (not merged) when the consolidated PRD PR opens.

## Decision

Adopt **(1) GitHub-side stacking**.

- Child PR base = PRD branch. Created manually via `gh pr create --base <prd>`.
- PRD PR base = `main`. Created by `finalize-prd` once all child PRs are MERGED.
- The existing `close-branch` cleanup gate (`gh pr view <branch>` → MERGED) works unchanged for both levels.

## Consequences

**Good.**
- Per-child CI signal lights up in the tmux window-list via the existing `pr-status` script.
- Smaller PRs are easier to review than one consolidated PRD-PR.
- The `close-branch` cleanup logic is symmetric for children and PRD — no special case.
- `finalize-prd` becomes a simple precondition-check + `gh pr create`.

**Bad.**
- N+1 PRs per PRD adds GitHub noise. Teams allergic to PR count will dislike this.
- Sibling drift becomes a real concern (ADR'd implicitly via the `sync-from-prd` command + TUI drift indicator).
- Forces a pre-condition gate in `finalize-prd`: must refuse if any child PR is OPEN or CLOSED-unmerged.

**Reversibility.** Switching to (3) hybrid is cheap (script-side: stop merging child PRs, close them on `finalize-prd`). Switching to (2) local consolidation is more painful — `close-branch`'s MERGED gate is meaningless for never-merged child PRs, and the per-child CI affordance disappears.
