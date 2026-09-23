#!/usr/bin/env bash
# Regression test: every job under .github/workflows/ must run on
# ubuntu-latest, never self-hosted (revert of PR #105, issue #109).
#
# Run: bash scripts/tests/test-workflow-runners.sh   (exit 0 = all green)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

WORKFLOWS=(
  "pi-package.yml"
  "release.yml"
  "sync-skills.yml"
  "tests.yml"
)

for wf in "${WORKFLOWS[@]}"; do
  path="$ROOT/.github/workflows/$wf"
  if [[ ! -f "$path" ]]; then
    bad "$wf: missing"
    continue
  fi
  if rg -q '^\s*runs-on:\s*ubuntu-latest\s*$' "$path"; then
    ok "$wf: runs-on ubuntu-latest"
  else
    bad "$wf: missing 'runs-on: ubuntu-latest'"
  fi
done

if rg -q 'self-hosted' "$ROOT/.github/workflows/"; then
  bad "self-hosted still referenced under .github/workflows/"
else
  ok "no self-hosted references under .github/workflows/"
fi

exit $fail
