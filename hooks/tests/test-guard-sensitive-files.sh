#!/usr/bin/env bash
# Regression test for guard-sensitive-files.sh's .env anchoring (issue #8).
#
# DENY_PATHS/DENY_BASH must block real dotenv files (.env, .envrc,
# .environment, .env.local) at a leading path/name boundary, but must NOT
# false-positive on identifiers/filenames that merely end in ".env"
# (aws_key_pair.env, foo.env). A trailing-only anchor would wrongly allow
# .envrc/.environment — this test guards against that regression too.
#
# Run: bash hooks/tests/test-guard-sensitive-files.sh   (exit 0 = all green)
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD="$HOOKS/guard-sensitive-files.sh"
fail=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; }

# expect_rc DESCRIPTION EXPECTED_RC JSON_PAYLOAD
expect_rc() {
  local desc="$1" expected="$2" payload="$3" rc
  printf '%s' "$payload" | bash "$GUARD" >/dev/null 2>&1
  rc=$?
  if [[ "$rc" -eq "$expected" ]]; then
    ok "$desc (rc=$rc)"
  else
    bad "$desc (expected rc=$expected, got rc=$rc)"
    fail=1
  fi
}

bash_payload() { printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$1"; }
read_payload() { printf '{"tool_name":"Read","tool_input":{"file_path":"%s"}}' "$1"; }
write_payload() { printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$1"; }

echo "================ Bash command targets ================"
expect_rc "aws_key_pair.env -> allow"        0 "$(bash_payload "cat aws_key_pair.env")"
expect_rc "foo.env (mid-token) -> allow"     0 "$(bash_payload "echo foo.env")"
expect_rc ".env -> block"                    2 "$(bash_payload "cat .env")"
expect_rc ".envrc -> block"                  2 "$(bash_payload "cat .envrc")"
expect_rc ".environment -> block"            2 "$(bash_payload "cat .environment")"
expect_rc ".env.local -> block"              2 "$(bash_payload "cat .env.local")"
expect_rc "source .env -> block"             2 "$(bash_payload "source .env")"

echo "================ Read/Write file_path targets ================"
expect_rc "report.env -> allow (Read)"       0 "$(read_payload "report.env")"
expect_rc ".env -> block (Read)"             2 "$(read_payload ".env")"
expect_rc ".envrc -> block (Read)"           2 "$(read_payload ".envrc")"
expect_rc "report.env -> allow (Write)"      0 "$(write_payload "report.env")"
expect_rc ".env -> block (Write)"            2 "$(write_payload ".env")"
expect_rc ".envrc -> block (Write)"          2 "$(write_payload ".envrc")"

echo "========================================"
if [[ $fail -eq 0 ]]; then echo "ALL GREEN"; else echo "SOME FAILED"; fi
exit $fail
