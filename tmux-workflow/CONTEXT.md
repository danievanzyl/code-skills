# Context

Glossary for the tmux-workflow scripts. Domain language only — no implementation details.

## Glossary

### PRD
A long-lived feature branch that aggregates multiple GitHub issues. Child issue PRs target the PRD branch; the PRD's own PR targets `main`. Stacked-PR shape: many small PRs → PRD → `main`. The PRD owns a [[worktree]] from which child [[worktree]]s are created.

A PRD has no GitHub tracker artifact beyond its branch and (eventually) its PR. No epic issue, no milestone. The PRD name is whatever you pass to `new-prd <name>`.

### Project
A directory under `$REPO_BASE` containing a `src/` checkout. Maps 1:1 to a tmux session.

### Issue (child)
A GitHub issue. Every child worktree under a [[PRD]] is hard-linked to exactly one issue. `new-branch <issue-number>` fetches the issue title via `gh issue view`, slugifies it, creates branch `<prd>/<n>-<slug>`, and records the issue number in the stamp file. No escape hatch — child branches in a PRD must have an issue. For issueless scratch work, use the legacy `src/`-rooted `new-branch <name>` flow.

### TUI
The per-worktree dashboard occupying the bottom-right pane of every tmux window created by `new-prd`/`new-branch`/`open-worktree`. Custom Go binary using bubbletea. Two view modes auto-detected from the stamp file:

- **Child view** — diff vs PRD branch, this child's PR status + checks, linked GitHub issue (number + title).
- **PRD view** — diff vs `main`, table of children with their PR states (OPEN/MERGED/CLOSED + check icons), and a "ready to finalize" indicator when all children are MERGED.

### Worktree
A `git worktree` sibling of `src/`. One per branch. Currently flat under `$REPO_BASE/<project>/`. With PRDs, child worktrees branch off the [[PRD]] worktree instead of `src/`.

Hierarchy is strictly 2 levels — a [[PRD]] cannot have a sub-PRD. `new-prd` creates a PRD worktree off `main`. `new-branch` infers from cwd: inside a [[PRD]] worktree → child branch off the PRD; inside `src/` → flat branch off `main` (legacy non-PRD work).

**Disk layout:** flat under `$REPO_BASE/<project>/`. PRD dir = `<prd>`, child dir = `<prd>--<child>` (double-dash separator). Git branch names use slash namespacing: PRD branch `<prd>`, child branch `<prd>/<child>`.

**Merge flow (GitHub-side stacking):** Each child has its own GitHub PR targeting the [[PRD]] branch. Children get reviewed + merged on GitHub. PRD worktree pulls. Then a final PR is created from the PRD branch to `main`. Per-child CI signals show in tmux window list via `pr-status`.

**Sibling drift:** when child A's PR merges into the [[PRD]], siblings B and C don't auto-rebase. TUI's child view shows "PRD ahead by N commits" indicator. Manual `sync-from-prd` command (`git fetch && git rebase <prd-branch>`) is run from inside the child worktree when desired.

**PR automation level (manual-first):**
- Child PRs: created manually by claude/user via `gh pr create --base <prd-branch>` when work is ready. `new-branch` does not auto-create.
- PRD worktree pull: manual, as part of finalize. No background daemon.
- PRD-to-`main` PR: explicit `finalize-prd` command. Verifies all child PRs are MERGED, then `git pull`, then `gh pr create --base main`. Refuses if any child PR is OPEN or CLOSED-unmerged.
