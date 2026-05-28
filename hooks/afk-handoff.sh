#!/usr/bin/env bash
set -euo pipefail
cd "$CLAUDE_PROJECT_DIR"

branch=$(git rev-parse --abbrev-ref HEAD)
worktree=$(git rev-parse --show-toplevel)

# Primary: parse from branch name
issue=$(echo "$branch" | grep -oP '/\K\d+' | head -1 || true)

# Fallback: parse from commit trailer
if [[ -z "$issue" ]]; then
  issue=$(git log -1 --format=%B | grep -oP '^Refs: #\K\d+' || true)
fi

# Fallback: parse from PR if it exists
if [[ -z "$issue" ]]; then
  issue=$(gh pr view --json body,title -q '.title + " " + .body' 2>/dev/null | grep -oP '#\K\d+' | head -1 || true)
fi

if [[ -z "$issue" ]]; then
  echo "afk-handoff: could not determine issue ID for branch ${branch}" >&2
  exit 0 # don't block, just skip handoff
fi

pr=$(gh pr list --head "$branch" --json number -q '.[0].number' 2>/dev/null || echo "")
last_sha=$(git rev-parse HEAD)

mkdir -p .claude/state
cat >".claude/state/issue-${issue}.json" <<EOF
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
  gh pr comment "$pr" --body "🤖 AFK runner completed work at \`${last_sha}\`. Reviewer state written to \`.claude/state/issue-${issue}.json\`."
fi
