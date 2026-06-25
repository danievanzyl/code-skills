#!/usr/bin/env bash
# Regression test for the AFK SubagentStop hooks (afk-handoff.sh,
# code-reviewer-push.sh) under worktree-isolation.
#
# A `isolation: worktree` subagent runs on a HARNESS-NAMED branch (agent-<id>),
# NOT a <type>/<N>-<slug> branch. So no issue number is derivable from git, and
# afk-handoff is AUDIT-ONLY: it posts a completion comment to the PR (if any) and
# writes NO state file. Correctness rides on orchestrator-held data — the runner
# RETURNS its PR#/branch and the orchestrator feeds the reviewer explicitly.
# code-reviewer-push still pushes the reviewer's `RALPH:` commits from the
# (isolated) reviewer worktree, whatever the branch is named.
#
# Run: bash hooks/tests/test-afk-hooks.sh   (exit 0 = all green)
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

# --- stub `gh` on PATH: a PR (#77) exists for the agent branch, and its body
# mentions issue #51. The audit-only hook must comment on #77 but must NOT mine
# that #51 back into a state file (the old branch/trailer/PR-body derivation is
# deleted). Record every gh call so we can assert the comment fired.
BIN="$TMP/bin"; mkdir -p "$BIN"
GH_LOG="$TMP/gh.log"; : >"$GH_LOG"
cat >"$BIN/gh" <<STUB
#!/usr/bin/env bash
echo "\$*" >>"$GH_LOG"
case "\$1 \$2" in
  "pr list") echo "77" ;;        # a PR exists for --head <branch>
  "pr view") echo "fixes #51" ;; # body mentions an issue — must be ignored
  *)         : ;;
esac
STUB
chmod +x "$BIN/gh"
export PATH="$BIN:$PATH"

# --- parent project ($CLAUDE_PROJECT_DIR), sits on main ---
PARENT="$TMP/parent"; mkdir -p "$PARENT"; cd "$PARENT"
git init -q -b main && git commit -q --allow-empty -m "parent main"

# --- agent worktree, on the HARNESS-NAMED branch agent-abc123 ---
WT="$TMP/agent-worktree"; mkdir -p "$WT"; cd "$WT"
git init -q -b agent-abc123
echo hi > f.txt && git add f.txt && git commit -q -m "implement thing"

payload() { printf '{"cwd":"%s","agent_type":"agentic-platform:%s","hook_event_name":"SubagentStop"}' "$WT" "$1"; }

echo "================ afk-handoff.sh (audit-only) ================"
payload afk-task-runner | CLAUDE_PROJECT_DIR="$PARENT" bash "$HOOKS/afk-handoff.sh"
rc=$?
[[ $rc -eq 0 ]] && ok "afk-handoff exit 0 on harness-named branch agent-abc123" || bad "afk-handoff exit $rc"

# writes NO state file — issue-N.json is dropped entirely (and the #51 in the PR
# body must NOT resurrect it: the derivation that mined it is deleted).
if compgen -G "$PARENT/.claude/state/issue-*.json" >/dev/null; then
  bad "wrote a state file (issue-*.json) — must be audit-only now"
else
  ok "wrote NO state file (issue-N.json dropped; #51 in PR body did not resurrect it)"
fi

# posts the audit comment on the branch's PR (#77 from the gh stub)
if grep -q "pr comment 77" "$GH_LOG"; then
  ok "posted audit PR comment on #77"
else
  bad "did not post audit PR comment (gh calls: $(tr '\n' '|' <"$GH_LOG"))"
fi

echo "================ code-reviewer-push.sh ================"
REMOTE="$TMP/remote.git"; git init -q --bare "$REMOTE"
cd "$WT"; git remote add origin "$REMOTE"

# negative: no RALPH commit -> must no-op, no push
payload code-reviewer | CLAUDE_PROJECT_DIR="$PARENT" bash "$HOOKS/code-reviewer-push.sh"
if git -C "$REMOTE" rev-parse --verify -q refs/heads/agent-abc123 >/dev/null; then
  bad "pushed despite no RALPH: commit"
else
  ok "no RALPH: commit -> no push (correct no-op)"
fi

# positive: a RALPH commit -> must push the reviewer worktree's branch
echo fix >> f.txt && git add f.txt && git commit -q -m "RALPH: Review - fix edge case"
payload code-reviewer | CLAUDE_PROJECT_DIR="$PARENT" bash "$HOOKS/code-reviewer-push.sh"
if git -C "$REMOTE" rev-parse --verify -q refs/heads/agent-abc123 >/dev/null; then
  ok "RALPH: commit -> pushed agent-abc123 from the reviewer's worktree"
else
  bad "did NOT push after RALPH: commit"
fi

echo "========================================"
[[ $fail -eq 0 ]] && echo "ALL GREEN" || echo "SOME FAILED"
exit $fail
