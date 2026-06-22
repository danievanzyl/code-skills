#!/usr/bin/env bash
set -euo pipefail

# SubagentStop delivers the stopped subagent's context as JSON on stdin. The
# runner does its work in its own (worktree-isolated) cwd; CLAUDE_PROJECT_DIR is
# the PARENT session's checkout, which sits on a different branch. So read the
# git state from the agent's worktree, but write the handoff file to the parent
# project's durable .claude/state — that is where the reviewer looks for it, and
# it survives the runner's worktree being removed before review.
input=$(cat || true)
agent_dir=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)
agent_dir="${agent_dir:-${CLAUDE_PROJECT_DIR:-$PWD}}"
project_dir="${CLAUDE_PROJECT_DIR:-$agent_dir}"

branch=$(git -C "$agent_dir" rev-parse --abbrev-ref HEAD)
worktree=$(git -C "$agent_dir" rev-parse --show-toplevel)

# Branch name → issue number (e.g. feat/142-foo → 142)
issue=$(echo "$branch" | sed -nE 's|.*/([0-9]+)-.*|\1|p')

# Commit trailer fallback
if [[ -z "$issue" ]]; then
  issue=$(git -C "$agent_dir" log -1 --format=%B | sed -nE 's/^Refs: #([0-9]+).*/\1/p')
fi

# PR fallback ( || true so a missing PR doesn't trip set -e )
# TODO(#13): the trailing `| head -1` SIGPIPEs sed under pipefail+set -e — drop it.
if [[ -z "$issue" ]]; then
  issue=$( { (cd "$agent_dir" && gh pr view --json body,title -q '.title + " " + .body' 2>/dev/null) || true; } |
    sed -nE 's/.*#([0-9]+).*/\1/p' | head -1)
fi

pr=$( (cd "$agent_dir" && gh pr list --head "$branch" --json number -q '.[0].number' 2>/dev/null) || echo "")
last_sha=$(git -C "$agent_dir" rev-parse HEAD)

mkdir -p "$project_dir/.claude/state"
cat >"$project_dir/.claude/state/issue-${issue}.json" <<EOF
{
  "issue": "${issue}",
  "branch": "${branch}",
  "worktree": "${worktree}",
  "pr": "${pr}",
  "last_sha": "${last_sha}",
  "completed_at": "$(date -Iseconds)",
  "completed_by": "afk-task-runner"
}
EOF

# Also post the human-readable narrative to the PR if one exists
if [[ -n "$pr" ]]; then
  (cd "$agent_dir" && gh pr comment "$pr" --body "🤖 AFK runner completed work at \`${last_sha}\`. Reviewer state written to \`.claude/state/issue-${issue}.json\`.")
fi
