#!/usr/bin/env bash
set -euo pipefail

# SubagentStop payload (stdin) carries the reviewer's cwd. The reviewer commits
# its RALPH: fixes in the worktree it reviewed in, NOT in CLAUDE_PROJECT_DIR (the
# parent session's checkout, on a different branch), so push from the agent's cwd.
input=$(cat || true)
agent_dir=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)
agent_dir="${agent_dir:-${CLAUDE_PROJECT_DIR:-$PWD}}"
cd "$agent_dir"

branch=$(git rev-parse --abbrev-ref HEAD)

# Only push if the reviewer actually made commits (look for RALPH: prefix in
# recent history). Read into a var first: piping `git log` straight into
# `grep -q` lets grep exit on first match and SIGPIPE git, which `set -o pipefail`
# then reports as failure — flipping this check and silently skipping the push.
recent=$(git log --oneline -5 || true)
if ! grep -q "RALPH:" <<<"$recent"; then
  exit 0
fi

# Push, setting upstream if not already set
git push -u origin "$branch"
