#!/usr/bin/env bash
set -euo pipefail
cd "$CLAUDE_PROJECT_DIR"

echo "$(date -Iseconds) afk-handoff fired, args=$*, cwd=$(pwd)" >>/tmp/claude-hooks.log

branch=$(git rev-parse --abbrev-ref HEAD)
worktree=$(git rev-parse --show-toplevel)

# Branch name → issue number (e.g. feat/142-foo → 142)
issue=$(echo "$branch" | sed -nE 's|.*/([0-9]+)-.*|\1|p')

# Commit trailer fallback
if [[ -z "$issue" ]]; then
  issue=$(git log -1 --format=%B | sed -nE 's/^Refs: #([0-9]+).*/\1/p')
fi

# PR fallback
if [[ -z "$issue" ]]; then
  issue=$(gh pr view --json body,title -q '.title + " " + .body' 2>/dev/null |
    sed -nE 's/.*#([0-9]+).*/\1/p' | head -1)
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
