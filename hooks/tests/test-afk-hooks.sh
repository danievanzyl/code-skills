#!/usr/bin/env bash
# Regression test for the AFK SubagentStop hooks (afk-handoff.sh,
# code-reviewer-push.sh).
#
# Reproduces the topology that broke them in a consumer repo: the parent session
# sits on `main` while the runner/reviewer subagent works in a SEPARATE worktree
# on `feat/51-foo`. The hook receives the SubagentStop JSON on stdin — its `cwd`
# field is the subagent's worktree, NOT $CLAUDE_PROJECT_DIR. The hooks must act
# on that worktree.
#
# Run: bash hooks/tests/test-afk-hooks.sh   (exit 0 = all green)
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

# --- parent project ($CLAUDE_PROJECT_DIR), sits on main ---
PARENT="$TMP/parent"; mkdir -p "$PARENT"; cd "$PARENT"
git init -q -b main && git commit -q --allow-empty -m "parent main"

# --- agent worktree, on feat/51-foo with real work ---
WT="$TMP/agent-worktree"; mkdir -p "$WT"; cd "$WT"
git init -q -b feat/51-foo
echo hi > f.txt && git add f.txt && git commit -q -m "implement thing"
WT_TOP=$(git rev-parse --show-toplevel)

payload() { printf '{"cwd":"%s","agent_type":"agentic-platform:%s","hook_event_name":"SubagentStop"}' "$WT" "$1"; }

echo "================ afk-handoff.sh ================"
payload afk-task-runner | CLAUDE_PROJECT_DIR="$PARENT" bash "$HOOKS/afk-handoff.sh"
rc=$?
[[ $rc -eq 0 ]] && ok "afk-handoff exit 0 (no set -e early-exit on a no-PR branch)" || bad "afk-handoff exit $rc"
STATE="$PARENT/.claude/state/issue-51.json"
if [[ -f "$STATE" ]]; then
  ok "wrote issue-51.json to PARENT durable state (survives worktree removal)"
  [[ "$(jq -r .issue "$STATE")"    == "51" ]]          && ok "issue=51 (from worktree branch, not parent main)" || bad "issue=$(jq -r .issue "$STATE")"
  [[ "$(jq -r .branch "$STATE")"   == "feat/51-foo" ]] && ok "branch=feat/51-foo"                                || bad "branch=$(jq -r .branch "$STATE")"
  [[ "$(jq -r .worktree "$STATE")" == "$WT_TOP" ]]     && ok "worktree=agent worktree (reviewer can locate it)"  || bad "worktree=$(jq -r .worktree "$STATE")"
else
  bad "issue-51.json NOT written"
fi

echo "================ code-reviewer-push.sh ================"
REMOTE="$TMP/remote.git"; git init -q --bare "$REMOTE"
cd "$WT"; git remote add origin "$REMOTE"

# negative: no RALPH commit -> must no-op, no push
payload code-reviewer | CLAUDE_PROJECT_DIR="$PARENT" bash "$HOOKS/code-reviewer-push.sh"
if git -C "$REMOTE" rev-parse --verify -q refs/heads/feat/51-foo >/dev/null; then
  bad "pushed despite no RALPH: commit"
else
  ok "no RALPH: commit -> no push (correct no-op)"
fi

# positive: a RALPH commit -> must push the worktree's branch
echo fix >> f.txt && git add f.txt && git commit -q -m "RALPH: Review - fix edge case"
payload code-reviewer | CLAUDE_PROJECT_DIR="$PARENT" bash "$HOOKS/code-reviewer-push.sh"
if git -C "$REMOTE" rev-parse --verify -q refs/heads/feat/51-foo >/dev/null; then
  ok "RALPH: commit -> pushed feat/51-foo from the reviewer's worktree"
else
  bad "did NOT push after RALPH: commit"
fi

echo "========================================"
[[ $fail -eq 0 ]] && echo "ALL GREEN" || echo "SOME FAILED"
exit $fail
