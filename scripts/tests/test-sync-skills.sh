#!/usr/bin/env bash
# Regression test for scripts/sync-skills.sh — both the `include_categories`
# mirror shape and the `skills[]` single-skill shape (added for herdr, #45).
#
# Runs entirely offline: builds tiny local git repos as upstream fixtures and
# redirects the script's hardcoded `https://github.com/<repo>` clone URLs to
# them via a scoped git config (`url.<local>.insteadOf`), so no network is
# needed and no live-upstream drift can flake this test.
#
# Run: bash scripts/tests/test-sync-skills.sh   (exit 0 = all green)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # scripts/
ROOT="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

git config --global user.email >/dev/null 2>&1 || git config --global user.email "ci@example.com"
git config --global user.name  >/dev/null 2>&1 || git config --global user.name  "CI"

# --- upstream fixtures -------------------------------------------------

MIRROR_UP="$TMP/upstream-mirror"      # include_categories shape
mkdir -p "$MIRROR_UP/skills/engineering/foo-skill" \
         "$MIRROR_UP/skills/productivity/bar-skill" \
         "$MIRROR_UP/skills/engineering/excluded-skill"
(
  cd "$MIRROR_UP" || exit 1
  git init -q -b main
  echo "# foo" > skills/engineering/foo-skill/SKILL.md
  echo "# bar" > skills/productivity/bar-skill/SKILL.md
  echo "# excluded" > skills/engineering/excluded-skill/SKILL.md
  echo "MIT FIXTURE LICENSE" > LICENSE
  git add -A && git commit -q -m init
)

SINGLE_UP="$TMP/upstream-single"      # skills[] shape (herdr-like: file at root)
mkdir -p "$SINGLE_UP/dir-skill/nested"
(
  cd "$SINGLE_UP" || exit 1
  git init -q -b master
  echo "# single skill at root" > SKILL.md
  echo "# dir skill" > dir-skill/SKILL.md
  echo "nested asset" > dir-skill/nested/asset.txt
  echo "AGPL FIXTURE LICENSE" > LICENSE
  git add -A && git commit -q -m init
)

# Redirect the script's github.com URLs to the local fixtures above, scoped to
# this test only via a throwaway GIT_CONFIG_GLOBAL (never touches the real
# user gitconfig).
FIXTURE_GITCONFIG="$TMP/fixture-gitconfig"
cat > "$FIXTURE_GITCONFIG" <<EOF
[user]
	email = ci@example.com
	name = CI
[url "file://$MIRROR_UP"]
	insteadOf = https://github.com/test/mirror-provider
[url "file://$SINGLE_UP"]
	insteadOf = https://github.com/test/single-provider
EOF

run_sync() {
  # $1 = project dir (must contain plugin.json, scripts/, skills/, vendor/)
  ( cd "$1" && GIT_CONFIG_GLOBAL="$FIXTURE_GITCONFIG" GIT_CONFIG_SYSTEM=/dev/null \
      bash scripts/sync-skills.sh )
}

new_project() {
  # $1 = project dir to create; copies the real script under test (not the fixtures)
  local proj="$1"
  mkdir -p "$proj/scripts" "$proj/skills" "$proj/vendor"
  cp "$HERE/sync-skills.sh" "$proj/scripts/sync-skills.sh"
  cp "$ROOT/plugin.json" "$proj/plugin.json"
}

# --- test 1: include_categories shape unaffected (mattpocock-equivalent) ----

echo "================ include_categories shape ================"
P1="$TMP/proj-mirror"
new_project "$P1"
cat > "$P1/scripts/skill-sources.json" <<'EOF'
{ "providers": [ { "name": "mirror", "repo": "test/mirror-provider", "ref": "main",
  "license": "MIT", "include_categories": ["engineering", "productivity"],
  "exclude_skills": ["excluded-skill"] } ] }
EOF
run_sync "$P1" >"$TMP/p1.log" 2>&1

if [ -f "$P1/skills/foo-skill/SKILL.md" ]; then ok "foo-skill vendored"; else bad "foo-skill missing"; fi
if [ -f "$P1/skills/bar-skill/SKILL.md" ]; then ok "bar-skill vendored"; else bad "bar-skill missing"; fi
if [ -e "$P1/skills/excluded-skill" ]; then
  bad "excluded-skill was vendored (must be excluded)"
else
  ok "excluded-skill correctly excluded"
fi
if [ -f "$P1/vendor/mirror/LICENSE" ]; then ok "vendor/mirror/LICENSE written"; else bad "vendor/mirror/LICENSE missing"; fi

# --- test 2: skills[] shape, file path -> SKILL.md --------------------------

echo "================ skills[] shape: file path ================"
P2="$TMP/proj-single"
new_project "$P2"
cat > "$P2/scripts/skill-sources.json" <<'EOF'
{ "providers": [ { "name": "single", "repo": "test/single-provider", "ref": "master",
  "license": "AGPL-3.0-or-later", "skills": [ { "name": "herdr-like", "path": "SKILL.md" } ] } ] }
EOF
run_sync "$P2" >"$TMP/p2.log" 2>&1

if [ -f "$P2/skills/herdr-like/SKILL.md" ]; then
  ok "file-path skill lands at skills/<name>/SKILL.md"
else
  bad "file-path skill did not land correctly ($(ls "$P2/skills/herdr-like" 2>&1))"
fi
if [ -f "$P2/skills/herdr-like/LICENSE" ]; then
  ok "upstream LICENSE copied into skill dir (travels with npx skills add)"
else
  bad "LICENSE missing from skills/herdr-like/"
fi
if [ -f "$P2/vendor/single/LICENSE" ]; then
  ok "upstream LICENSE also copied into vendor/<provider>/"
else
  bad "LICENSE missing from vendor/single/"
fi
if [ -f "$P2/skills/herdr-like/.vendored-from" ] && \
   jq -e '.provider == "single" and .upstream == "SKILL.md" and (.sha | length) == 40' \
     "$P2/skills/herdr-like/.vendored-from" >/dev/null 2>&1; then
  ok "marker well-formed {provider,repo,ref,sha,upstream}"
else
  bad "marker malformed: $(cat "$P2/skills/herdr-like/.vendored-from" 2>&1)"
fi

# --- test 3: skills[] shape, directory path -> recursive copy ---------------

echo "================ skills[] shape: directory path ================"
P3="$TMP/proj-dir"
new_project "$P3"
cat > "$P3/scripts/skill-sources.json" <<'EOF'
{ "providers": [ { "name": "single", "repo": "test/single-provider", "ref": "master",
  "license": "AGPL-3.0-or-later", "skills": [ { "name": "dir-skill", "path": "dir-skill" } ] } ] }
EOF
run_sync "$P3" >"$TMP/p3.log" 2>&1

if [ -f "$P3/skills/dir-skill/SKILL.md" ] && [ -f "$P3/skills/dir-skill/nested/asset.txt" ]; then
  ok "directory-path skill copied recursively, nested files preserved"
else
  bad "directory-path skill copy incomplete: $(find "$P3/skills/dir-skill" -type f 2>&1 | tr '\n' ' ')"
fi

# --- test 4: collision guard never clobbers a hand-authored skill -----------

echo "================ skills[] shape: collision guard ================"
P4="$TMP/proj-collision"
new_project "$P4"
mkdir -p "$P4/skills/herdr-like"
echo "HAND AUTHORED - DO NOT TOUCH" > "$P4/skills/herdr-like/SKILL.md"
cat > "$P4/scripts/skill-sources.json" <<'EOF'
{ "providers": [ { "name": "single", "repo": "test/single-provider", "ref": "master",
  "license": "AGPL-3.0-or-later", "skills": [ { "name": "herdr-like", "path": "SKILL.md" } ] } ] }
EOF
run_sync "$P4" >"$TMP/p4.log" 2>&1

if grep -q "HAND AUTHORED" "$P4/skills/herdr-like/SKILL.md" 2>/dev/null; then
  ok "collision-skip: hand-authored skills/herdr-like left untouched"
else
  bad "collision guard failed — hand-authored skill was overwritten"
fi
if grep -q "SKIPPED (collision)" "$TMP/p4.log"; then
  ok "collision was logged"
else
  bad "no collision warning logged: $(cat "$TMP/p4.log")"
fi

# --- test 5: missing upstream path is a warning, not a crash ----------------

echo "================ skills[] shape: missing upstream path ================"
P5="$TMP/proj-missing"
new_project "$P5"
cat > "$P5/scripts/skill-sources.json" <<'EOF'
{ "providers": [ { "name": "single", "repo": "test/single-provider", "ref": "master",
  "license": "AGPL-3.0-or-later", "skills": [ { "name": "ghost", "path": "does/not/exist.md" } ] } ] }
EOF
if run_sync "$P5" >"$TMP/p5.log" 2>&1; then
  if [ ! -e "$P5/skills/ghost" ] && grep -q "path not found upstream" "$TMP/p5.log"; then
    ok "missing upstream path warns and skips, script still exits 0"
  else
    bad "missing-path handling wrong: $(cat "$TMP/p5.log")"
  fi
else
  bad "script exited non-zero on missing upstream path (should warn+skip, not crash)"
fi

# --- test 6: idempotency — a second run yields an identical tree, both shapes -

echo "================ idempotency (both shapes, two full runs) ================"
P6="$TMP/proj-idempotent"
new_project "$P6"
cat > "$P6/scripts/skill-sources.json" <<'EOF'
{ "providers": [
  { "name": "mirror", "repo": "test/mirror-provider", "ref": "main",
    "license": "MIT", "include_categories": ["engineering", "productivity"],
    "exclude_skills": ["excluded-skill"] },
  { "name": "single", "repo": "test/single-provider", "ref": "master",
    "license": "AGPL-3.0-or-later", "skills": [ { "name": "herdr-like", "path": "SKILL.md" } ] }
] }
EOF
run_sync "$P6" >"$TMP/p6a.log" 2>&1
find "$P6/skills" "$P6/vendor" -type f | sort > "$TMP/p6-run1-files.txt"
run_sync "$P6" >"$TMP/p6b.log" 2>&1
find "$P6/skills" "$P6/vendor" -type f | sort > "$TMP/p6-run2-files.txt"

if diff -q "$TMP/p6-run1-files.txt" "$TMP/p6-run2-files.txt" >/dev/null; then
  ok "second run produces an identical file list (no drift, no orphans)"
else
  bad "second run's file list differs from the first: $(diff "$TMP/p6-run1-files.txt" "$TMP/p6-run2-files.txt")"
fi
if grep -q "SKIPPED (collision)" "$TMP/p6b.log"; then
  bad "second run hit an unexpected self-collision (prune-then-recopy should avoid this): $(cat "$TMP/p6b.log")"
else
  ok "second run re-synced cleanly with no self-collision"
fi

echo "========================================"
if [ "$fail" -eq 0 ]; then echo "ALL GREEN"; else echo "SOME FAILED"; fi
exit "$fail"
