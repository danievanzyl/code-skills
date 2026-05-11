#!/bin/bash

issues=$(cat issues/*.md 2>/dev/null || echo "No issues found")
commits=$(git log -n 5 --format="%H%n%ad%n%B---" --date=short 2>/dev/null || echo "No commits found")
prompt=$(cat "${1:-ralph/prompt.md}")

claude --permission-mode acceptEdits \
  --dangerously-skip-permissions \
  "Previous commits: $commits Issues: $issues $prompt"
