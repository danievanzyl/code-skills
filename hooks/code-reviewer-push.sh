#!/usr/bin/env bash
set -euo pipefail

cd "$CLAUDE_PROJECT_DIR"

branch=$(git rev-parse --abbrev-ref HEAD)

# Only push if the reviewer actually made commits (look for RALPH: prefix in recent history)
if ! git log --oneline -5 | grep -q "RALPH:"; then
  exit 0
fi

# Push, setting upstream if not already set
git push -u origin "$branch"
