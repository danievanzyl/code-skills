#!/usr/bin/env bash
# .claude/hooks/add-refs-trailer.sh
set -euo pipefail
cd "$CLAUDE_PROJECT_DIR"

branch=$(git rev-parse --abbrev-ref HEAD)
issue=$(echo "$branch" | grep -oP '/\K\d+' | head -1 || echo "")
[[ -z "$issue" ]] && exit 0 # no issue ID parseable, nothing to add

# Only amend if trailer not already present
if ! git log -1 --format=%B | grep -q "^Refs: #${issue}"; then
  git commit --amend --no-edit --trailer "Refs: #${issue}"
fi
