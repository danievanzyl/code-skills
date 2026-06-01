#!/bin/bash

issues=$(gh issue list \
  --label ready-for-agent \
  --state open \
  --json number,title,body,labels \
  --jq 'sort_by(.number) | .[] | "## Issue #\(.number): \(.title)\n\nLabels: \([.labels[].name] | join(", "))\n\n\(.body)\n\n---\n"' \
  2>/dev/null || echo "No issues found")
commits=$(git log -n 5 --format="%H%n%ad%n%B---" --date=short 2>/dev/null || echo "No commits found")
prompt=$(cat "${1:-ralph/prompt.md}")

claude --permission-mode acceptEdits --dangerously-skip-permissions \
  "Previous commits: $commits Issues: $issues $prompt"
