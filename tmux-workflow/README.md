# Tmux + Ghostty + Claude Code workflow

Drafted scripts replacing Superset. See `~/.claude/projects/-Users-danievanzyl-code-ritdu-WORKDIR/memory/user_workflow_tmux_ghostty.md` for the design rationale.

## Install

```sh
chmod +x sessionizer new-branch close-branch
mv sessionizer new-branch close-branch ~/bin/
cat tmux.conf.snippet >> ~/.tmux.conf
tmux source-file ~/.tmux.conf
```

Requires: `tmux >= 3.4` (for `split-window -l <pct>%`), `fd`, `fzf`, `gh` (authenticated), `git`.

## Use

- `prefix-T` → fzf popup → pick project → tmux session created (or attached) with a 3-pane `src` window.
- Inside a project session: `new-branch fix-login-redirect` → creates worktree at `~/code/ritdu/<project>/fix-login-redirect`, opens new tmux window with claude + 2 terms.
- `prefix-X` → cleanup current window's worktree (only deletes if PR is merged on GitHub).
- Auto: when a window dies (last pane closed or `kill-window`), `window-unlinked` hook runs `close-branch` silently — same PR-merged gate.

## Cleanup gate

`close-branch` deletes a worktree only when `gh pr view "$BRANCH" --json state -q .state` returns `MERGED`. All other states (no PR, OPEN, CLOSED unmerged) and all errors (offline, unauth) → no-op. The `src` checkout is never deleted regardless.

## Files

- `sessionizer` — project switcher (fzf over `$REPO_BASE`, default `~/code/ritdu`).
- `new-branch` — branch creator (worktree + window + panes + claude).
- `close-branch` — cleanup script, handles both manual (`prefix-X`) and hook (`window-unlinked`) entry points.
- `tmux.conf.snippet` — hook + bindings, append to `~/.tmux.conf`.

## Notes

- Project name = tmux session name = directory under `$REPO_BASE`. Sessionizer enforces this; `new-branch` relies on it.
- Worktree metadata is stamped at creation in `~/.cache/tmux-worktrees/<window-id>` (sourced by `close-branch`).
- The `git-worktree` skill is retired — don't reinstate. Claude works inside cwd it was launched in; doesn't manage worktree lifecycle.
