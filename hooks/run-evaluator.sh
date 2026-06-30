#!/usr/bin/env bash
# Run Evaluator trigger — runs on the code-reviewer SubagentStop event, AFTER
# code-reviewer-push.sh has pushed the reviewer's fixes (hooks in a matcher run
# in array order). It resolves the PR from the reviewer's worktree and publishes
# an ADVISORY Scorecard (eval/scripts/eval-pr.ts --publish): a security commit
# status + a Scorecard comment.
#
# Read-only w.r.t. the diff — it never pushes commits. ADVISORY-first rollout: it
# never passes --fail-on-gate and always exits 0, so it cannot block the agent or
# the merge (eval/security is a commit status, NOT a required branch-protection
# check yet). Health + output logged.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_root="${CLAUDE_PLUGIN_ROOT:-$(dirname "$script_dir")}"
state_dir="${RUN_EVAL_STATE_DIR:-$HOME/.run-eval}"
log="$state_dir/evaluator.log"
mkdir -p "$state_dir" 2>/dev/null || true
ts() { date -u +%FT%TZ 2>/dev/null || date; }

# SubagentStop payload carries the reviewer's cwd. The reviewer ran
# `gh pr checkout <n>` into its OWN worktree, so resolve PR# + owner/repo there.
input=$(cat || true)
agent_dir=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)
agent_dir="${agent_dir:-${CLAUDE_PROJECT_DIR:-$PWD}}"

if ! command -v bun >/dev/null 2>&1; then
  printf '%s eval skipped: bun not on PATH\n' "$(ts)" >>"$log" 2>/dev/null || true
  exit 0
fi

pr=$( (cd "$agent_dir" && gh pr view --json number -q .number 2>/dev/null) || echo "" )
repo=$( (cd "$agent_dir" && gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) || echo "" )
if [[ -z "$pr" || -z "$repo" ]]; then
  printf '%s eval skipped: no PR/repo resolvable from %s\n' "$(ts)" "$agent_dir" >>"$log" 2>/dev/null || true
  exit 0
fi

# Ensure eval deps once (best-effort; the advisory path tolerates failure).
if [[ ! -d "$plugin_root/eval/node_modules" ]]; then
  ( cd "$plugin_root/eval" && bun install ) >>"$log" 2>&1 || true
fi

printf '%s evaluating PR #%s (%s)\n' "$(ts)" "$pr" "$repo" >>"$log" 2>/dev/null || true
( cd "$plugin_root/eval" && bun run scripts/eval-pr.ts --pr "$pr" --repo "$repo" --publish ) >>"$log" 2>&1 \
  || printf '%s eval-pr.ts failed for PR #%s\n' "$(ts)" "$pr" >>"$log" 2>/dev/null || true
exit 0
