#!/usr/bin/env bash
# .claude/hooks/validate-branch-name.sh
# Fires on PreToolUse for Bash commands matching git branch creation
input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command')

# Only check branch-creation commands
if [[ ! "$cmd" =~ git[[:space:]]+(checkout[[:space:]]+-b|switch[[:space:]]+-c|branch) ]]; then
  exit 0
fi

# Pattern: <type>/<issue-id>-<slug>
if [[ ! "$cmd" =~ (feat|fix|chore|refactor|perf|docs|test)/[0-9]+- ]]; then
  echo '{"decision":"block","reason":"Branch name must match <type>/<issue-id>-<slug>. See CODING_STANDARDS §14."}' >&2
  exit 2
fi
