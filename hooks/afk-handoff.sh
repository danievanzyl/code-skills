#!/usr/bin/env bash
set -euo pipefail

# SubagentStop delivers the stopped subagent's context as JSON on stdin. A
# worktree-isolated runner works on a HARNESS-NAMED branch (agent-<id>), not a
# <type>/<N>-<slug> branch — so no issue number is derivable from git, and there
# is no reliable state to reconstruct here. Correctness rides on orchestrator-
# held data instead: the runner RETURNS its PR#/branch and the orchestrator feeds
# the reviewer explicitly. This hook is therefore AUDIT-ONLY — it posts a
# completion note to the PR (if one exists) and writes no state file.
input=$(cat || true)
agent_dir=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)
agent_dir="${agent_dir:-${CLAUDE_PROJECT_DIR:-$PWD}}"

branch=$(git -C "$agent_dir" rev-parse --abbrev-ref HEAD)
last_sha=$(git -C "$agent_dir" rev-parse HEAD)

# Post the audit narrative to the branch's PR if one exists ( || true so a
# missing PR / gh failure doesn't trip set -e ).
pr=$( (cd "$agent_dir" && gh pr list --head "$branch" --json number -q '.[0].number' 2>/dev/null) || echo "")
if [[ -n "$pr" ]]; then
  (cd "$agent_dir" && gh pr comment "$pr" --body "🤖 AFK runner completed work at \`${last_sha}\`.") || true
fi
