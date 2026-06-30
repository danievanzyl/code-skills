#!/usr/bin/env bash
# Run Evaluator capture hook — the Trajectory↔PR linker (see docs/adr/0001).
#
# Wired to BOTH the top-level Stop event (headless afk.sh, where the Runner is
# the top-level agent) and the afk-task-runner SubagentStop event (afk-issue,
# where the Runner is a spawned sub-agent). On each Runner finish it links the
# PR# to its transcript in the manifest by running eval/scripts/capture-run.ts.
#
# Audit-only: it must NEVER block the agent, so it always exits 0. capture-run.ts
# is itself exit-0-on-error, which means a MISSING `bun` would silently no-op —
# so this wrapper logs a health line when bun is absent, making that visible.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_root="${CLAUDE_PLUGIN_ROOT:-$(dirname "$script_dir")}"
state_dir="${RUN_EVAL_STATE_DIR:-$HOME/.run-eval}"
log="$state_dir/capture.log"
mkdir -p "$state_dir" 2>/dev/null || true
ts() { date -u +%FT%TZ 2>/dev/null || date; }

# Read the hook payload (JSON on stdin) so we can forward it to the bun script.
input=$(cat || true)

if ! command -v bun >/dev/null 2>&1; then
  printf '%s capture skipped: bun not on PATH\n' "$(ts)" >>"$log" 2>/dev/null || true
  exit 0
fi

printf '%s' "$input" \
  | bun run "$plugin_root/eval/scripts/capture-run.ts" >>"$log" 2>&1 \
  || printf '%s capture-run.ts exited nonzero\n' "$(ts)" >>"$log" 2>/dev/null || true
exit 0
