#!/usr/bin/env bash
# .claude/hooks/validate-branch-name.sh
# Fires on PreToolUse for Bash. Validates branch names ONLY on branch-CREATION
# commands. Read / list / delete / rename forms (git branch --list, git branch
# -d, git branch --show-current, bare `git branch`, etc.) pass through untouched.
input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command')

# Extract the NEW branch name from a recognised creation form. Anything else
# (reads, deletes, renames, no match) leaves $created empty and is allowed.
created=""
if [[ "$cmd" =~ git[[:space:]]+checkout[[:space:]]+-b[[:space:]]+([^[:space:]]+) ]]; then
  created="${BASH_REMATCH[1]}"
elif [[ "$cmd" =~ git[[:space:]]+switch[[:space:]]+-c[[:space:]]+([^[:space:]]+) ]]; then
  created="${BASH_REMATCH[1]}"
elif [[ "$cmd" =~ git[[:space:]]+branch[[:space:]]+([^-][^[:space:]]*) ]]; then
  # `git branch <name>` create form: the first token after `branch` is a bare
  # name, not a flag (-d/-D/-m/--list/...). No token at all = list = no match.
  created="${BASH_REMATCH[1]}"
fi

# Not a branch-creation command → allow.
[[ -z "$created" ]] && exit 0

# Pattern: <type>/<issue-id>-<slug>, validated against the new branch name only.
if [[ ! "$created" =~ ^(feat|fix|chore|refactor|perf|docs|test)/[0-9]+- ]]; then
  echo "{\"decision\":\"block\",\"reason\":\"Branch name '$created' must match <type>/<issue-id>-<slug> (e.g. feat/123-add-foo). See CODING_STANDARDS §14.\"}" >&2
  exit 2
fi
exit 0
