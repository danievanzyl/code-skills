#!/usr/bin/env bash
# Regression test for the Run Evaluator hooks (capture-run.sh, run-evaluator.sh).
#
# capture-run.sh links a finished Runner's PR# -> transcript in the manifest
# (eval/scripts/capture-run.ts). run-evaluator.sh resolves the PR from the
# reviewer's worktree and publishes an ADVISORY Scorecard (eval/scripts/eval-pr.ts).
# Both MUST always exit 0 (never block the agent) and MUST log a health line when
# `bun` is missing — because the underlying scripts are exit-0-on-error and would
# otherwise no-op silently.
#
# `gh` is stubbed on PATH; the eval TS itself is covered by `bun test` in eval/.
# Run: bash hooks/tests/test-eval-hooks.sh   (exit 0 = all green)
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$HOOKS/.." && pwd)"
FIXTURE="$ROOT/eval/tests/fixtures/clean-trajectory.jsonl"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

if ! command -v bun >/dev/null 2>&1; then
  echo "SKIP: bun not installed — cannot exercise the eval scripts"; exit 0
fi
[[ -d "$ROOT/eval/node_modules" ]] || ( cd "$ROOT/eval" && bun install >/dev/null 2>&1 ) || true

BIN="$TMP/bin"; mkdir -p "$BIN"

echo "================ capture-run.sh (bun present -> writes manifest) ================"
# Stub gh: capture-run.ts calls `gh pr view --json number,headRefOid` and JSON.parses it.
cat >"$BIN/gh" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "pr view") echo '{"number":77,"headRefOid":"deadbeefcafe"}' ;;
  *)         : ;;
esac
STUB
chmod +x "$BIN/gh"

STATE="$TMP/state"
WT="$TMP/agent-worktree"; mkdir -p "$WT"
payload="{\"cwd\":\"$WT\",\"transcript_path\":\"$FIXTURE\",\"session_id\":\"sess-1\",\"hook_event_name\":\"Stop\"}"

printf '%s' "$payload" | \
  PATH="$BIN:$PATH" RUN_EVAL_STATE_DIR="$STATE" CLAUDE_PLUGIN_ROOT="$ROOT" bash "$HOOKS/capture-run.sh"
rc=$?
[[ $rc -eq 0 ]] && ok "capture-run exit 0" || bad "capture-run exit $rc"

if [[ -f "$STATE/manifest.jsonl" ]] && grep -q '"pr":77' "$STATE/manifest.jsonl" \
   && grep -qF "$FIXTURE" "$STATE/manifest.jsonl"; then
  ok "capture wrote manifest entry linking PR #77 -> transcript"
else
  bad "capture did not write the expected manifest entry"
fi

echo "================ capture-run.sh (bun MISSING -> health log, no manifest) ================"
STATE2="$TMP/state2"
# PATH without the real bun (it lives outside /usr/bin:/bin) but with the gh stub.
printf '%s' "$payload" | \
  PATH="$BIN:/usr/bin:/bin" RUN_EVAL_STATE_DIR="$STATE2" CLAUDE_PLUGIN_ROOT="$ROOT" bash "$HOOKS/capture-run.sh"
rc=$?
[[ $rc -eq 0 ]] && ok "capture-run exit 0 when bun missing" || bad "capture-run exit $rc when bun missing"
if [[ -f "$STATE2/capture.log" ]] && grep -q "bun not on PATH" "$STATE2/capture.log"; then
  ok "logged health line when bun missing"
else
  bad "did not log a health line when bun missing"
fi
if [[ -f "$STATE2/manifest.jsonl" ]]; then
  bad "wrote a manifest despite bun missing"
else
  ok "no manifest written when bun missing (correct)"
fi

echo "================ run-evaluator.sh (no PR -> skip, exit 0) ================"
NOPR="$TMP/nopr-bin"; mkdir -p "$NOPR"
cat >"$NOPR/gh" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "pr view")   echo "" ;;   # gh pr view --json number -q .number  => empty (no PR)
  "repo view") echo "o/r" ;;
  *)           : ;;
esac
STUB
chmod +x "$NOPR/gh"
STATE3="$TMP/state3"
printf '{"cwd":"%s","agent_type":"code-reviewer","hook_event_name":"SubagentStop"}' "$WT" | \
  PATH="$NOPR:$PATH" RUN_EVAL_STATE_DIR="$STATE3" CLAUDE_PLUGIN_ROOT="$ROOT" bash "$HOOKS/run-evaluator.sh"
rc=$?
[[ $rc -eq 0 ]] && ok "run-evaluator exit 0 when no PR" || bad "run-evaluator exit $rc when no PR"
if grep -q "no PR/repo resolvable" "$STATE3/evaluator.log" 2>/dev/null; then
  ok "logged skip when no PR resolvable"
else
  bad "did not log skip when no PR resolvable"
fi

echo "================ run-evaluator.sh (PR present -> evaluates, publishes, exit 0) ================"
HAPPY="$TMP/happy-bin"; mkdir -p "$HAPPY"
GH_LOG="$TMP/happy-gh.log"; : >"$GH_LOG"
cat >"$HAPPY/gh" <<STUB
#!/usr/bin/env bash
echo "\$*" >>"$GH_LOG"
case "\$1 \$2" in
  "pr view")    echo "77" ;;            # --json number -q .number
  "repo view")  echo "o/r" ;;           # --json nameWithOwner -q .nameWithOwner
  "pr diff")    echo "+ clean change" ;;
  *)            : ;;                     # api (status), pr comment -> success
esac
exit 0
STUB
chmod +x "$HAPPY/gh"

STATE4="$TMP/state4"; mkdir -p "$STATE4"
# Seed the manifest so eval-pr.ts can resolve the Trajectory for PR #77.
printf '{"pr":77,"transcriptPath":"%s","sha":"deadbeefcafe","runId":"r1","event":"SubagentStop","ts":"2026-06-30T00:00:00Z"}\n' \
  "$FIXTURE" > "$STATE4/manifest.jsonl"

printf '{"cwd":"%s","agent_type":"code-reviewer","hook_event_name":"SubagentStop"}' "$WT" | \
  PATH="$HAPPY:$PATH" RUN_EVAL_STATE_DIR="$STATE4" CLAUDE_PLUGIN_ROOT="$ROOT" bash "$HOOKS/run-evaluator.sh"
rc=$?
[[ $rc -eq 0 ]] && ok "run-evaluator exit 0 on happy path" || bad "run-evaluator exit $rc on happy path"
if grep -q "evaluating PR #77" "$STATE4/evaluator.log" 2>/dev/null; then
  ok "invoked the evaluator for the resolved PR"
else
  bad "did not invoke the evaluator (log: $(cat "$STATE4/evaluator.log" 2>/dev/null))"
fi
if grep -q "pr comment 77" "$GH_LOG"; then
  ok "published a Scorecard comment to PR #77"
else
  bad "did not publish a Scorecard comment (gh calls: $(tr '\n' '|' <"$GH_LOG"))"
fi

echo "================ capture-run.sh --role reviewer (writes reviewer entry) ================"
STATE5="$TMP/state5"
payload_rev="{\"cwd\":\"$WT\",\"transcript_path\":\"$FIXTURE\",\"session_id\":\"sess-rev\",\"agent_type\":\"code-reviewer\",\"hook_event_name\":\"SubagentStop\"}"
printf '%s' "$payload_rev" | \
  PATH="$BIN:$PATH" RUN_EVAL_STATE_DIR="$STATE5" CLAUDE_PLUGIN_ROOT="$ROOT" bash "$HOOKS/capture-run.sh" --role reviewer
rc=$?
[[ $rc -eq 0 ]] && ok "capture-run --role reviewer exit 0" || bad "capture-run --role reviewer exit $rc"

if [[ -f "$STATE5/manifest.jsonl" ]] && grep -q '"role":"reviewer"' "$STATE5/manifest.jsonl" \
   && grep -q '"agentType":"code-reviewer"' "$STATE5/manifest.jsonl"; then
  ok "manifest entry carries role=reviewer and agentType=code-reviewer"
else
  bad "manifest entry missing role=reviewer/agentType ($(cat "$STATE5/manifest.jsonl" 2>/dev/null))"
fi

echo "================ capture-run.sh --role reviewer with wrong agent_type (issue #39 gate, no entry) ================"
STATE6="$TMP/state6"
payload_phantom="{\"cwd\":\"$WT\",\"transcript_path\":\"$FIXTURE\",\"session_id\":\"sess-phantom\",\"agent_type\":\"away-summary\",\"hook_event_name\":\"SubagentStop\"}"
printf '%s' "$payload_phantom" | \
  PATH="$BIN:$PATH" RUN_EVAL_STATE_DIR="$STATE6" CLAUDE_PLUGIN_ROOT="$ROOT" bash "$HOOKS/capture-run.sh" --role reviewer
rc=$?
[[ $rc -eq 0 ]] && ok "capture-run --role reviewer (bad agent_type) exit 0" || bad "capture-run --role reviewer (bad agent_type) exit $rc"
if [[ -f "$STATE6/manifest.jsonl" ]]; then
  bad "wrote a manifest entry despite agent_type mismatch (issue #39 gate failed)"
else
  ok "no manifest entry written when agent_type does not match --role (correct)"
fi

echo "================ capture-run.sh --role reviewer with MISSING agent_type (issue #39 gate, no entry) ================"
# This is the actual 2026-07-06 incident shape: the phantom SubagentStop
# carried NO agent_type at all, not merely a wrong one.
STATE6B="$TMP/state6b"
payload_missing="{\"cwd\":\"$WT\",\"transcript_path\":\"$FIXTURE\",\"session_id\":\"sess-missing\",\"hook_event_name\":\"SubagentStop\"}"
printf '%s' "$payload_missing" | \
  PATH="$BIN:$PATH" RUN_EVAL_STATE_DIR="$STATE6B" CLAUDE_PLUGIN_ROOT="$ROOT" bash "$HOOKS/capture-run.sh" --role reviewer
rc=$?
[[ $rc -eq 0 ]] && ok "capture-run --role reviewer (missing agent_type) exit 0" || bad "capture-run --role reviewer (missing agent_type) exit $rc"
if [[ -f "$STATE6B/manifest.jsonl" ]]; then
  bad "wrote a manifest entry despite missing agent_type (issue #39 gate failed on the actual incident shape)"
else
  ok "no manifest entry written when agent_type is missing (correct)"
fi

echo "================ run-evaluator.sh (SubagentStop, non-code-reviewer agent_type -> skip, no eval-pr) ================"
STATE7="$TMP/state7"
# NOPR's gh stub is irrelevant here — the agent_type gate must short-circuit
# before any `gh` call is made.
printf '{"cwd":"%s","agent_type":"away-summary","hook_event_name":"SubagentStop"}' "$WT" | \
  PATH="$NOPR:$PATH" RUN_EVAL_STATE_DIR="$STATE7" CLAUDE_PLUGIN_ROOT="$ROOT" bash "$HOOKS/run-evaluator.sh"
rc=$?
[[ $rc -eq 0 ]] && ok "run-evaluator exit 0 when agent_type is not code-reviewer" || bad "run-evaluator exit $rc when agent_type is not code-reviewer"
if grep -q 'agent_type "away-summary" is not code-reviewer' "$STATE7/evaluator.log" 2>/dev/null; then
  ok "logged skip for non-code-reviewer agent_type"
else
  bad "did not log skip for non-code-reviewer agent_type (log: $(cat "$STATE7/evaluator.log" 2>/dev/null))"
fi
if grep -q "evaluating PR" "$STATE7/evaluator.log" 2>/dev/null; then
  bad "invoked the evaluator despite agent_type mismatch (issue #39 gate failed)"
else
  ok "did not invoke the evaluator (correct)"
fi

echo "================ run-evaluator.sh (SubagentStop, MISSING agent_type -> skip, no eval-pr) ================"
# This is the actual 2026-07-06 incident shape: the phantom SubagentStop
# carried NO agent_type at all (not merely a wrong one). A gate that only
# rejects a present-but-wrong value would miss it.
STATE8="$TMP/state8"
printf '{"cwd":"%s","hook_event_name":"SubagentStop"}' "$WT" | \
  PATH="$NOPR:$PATH" RUN_EVAL_STATE_DIR="$STATE8" CLAUDE_PLUGIN_ROOT="$ROOT" bash "$HOOKS/run-evaluator.sh"
rc=$?
[[ $rc -eq 0 ]] && ok "run-evaluator exit 0 when agent_type is missing" || bad "run-evaluator exit $rc when agent_type is missing"
if grep -q 'agent_type "none" is not code-reviewer' "$STATE8/evaluator.log" 2>/dev/null; then
  ok "logged skip for missing agent_type"
else
  bad "did not log skip for missing agent_type (log: $(cat "$STATE8/evaluator.log" 2>/dev/null))"
fi
if grep -q "evaluating PR" "$STATE8/evaluator.log" 2>/dev/null; then
  bad "invoked the evaluator despite missing agent_type (issue #39 gate failed on the actual incident shape)"
else
  ok "did not invoke the evaluator (correct)"
fi

echo "========================================"
if [[ $fail -eq 0 ]]; then echo "ALL GREEN"; else echo "SOME FAILED"; fi
exit $fail
