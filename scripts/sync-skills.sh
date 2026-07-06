#!/usr/bin/env bash
#
# sync-skills.sh — vendor external skill providers into this marketplace.
#
# Reads scripts/skill-sources.json and mirrors a curated set of upstream skills
# into the plugin's top-level skills/<name>/ so Claude Code's one-level skill
# auto-discovery picks them up (a plugin.json `skills` array is NOT honored from
# a root plugin.json here, and nested skills/vendor/<p>/<name>/ is too deep — so
# vendored skills live flat alongside hand-authored ones, distinguished by a
# .vendored-from marker file).
#
# Each vendored skill dir gets a `.vendored-from` marker (JSON). The marker is
# what makes re-syncs safe: prune only ever removes dirs carrying THIS provider's
# marker, never a hand-authored skill — even if names later collide. Attribution
# (upstream LICENSE + provenance) goes in top-level vendor/<provider>/, which is
# not a plugin component dir so it is never scanned as a skill.
#
# Mutates the working tree only — it never commits, pushes, or opens PRs. Run it
# locally and review `git diff`; in CI the sync-skills workflow handles git + PR.
#
# Portable on purpose: POSIX find/grep/sed and bash 3.2 features only (runs on CI
# ubuntu AND macOS's stock bash), so no `fd`/`rg`/mapfile/`declare -A`.
#
# Usage: bash scripts/sync-skills.sh

set -euo pipefail
shopt -s nullglob

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
CONFIG="scripts/skill-sources.json"
SKILLS_DIR="skills"
VENDOR_DIR="vendor"          # top-level, attribution only (NOT a plugin component dir)
MARKER=".vendored-from"

for tool in jq git; do
  command -v "$tool" >/dev/null 2>&1 || { echo "sync-skills: '$tool' is required" >&2; exit 1; }
done
[ -f "$CONFIG" ] || { echo "sync-skills: missing $CONFIG" >&2; exit 1; }
[ -f "plugin.json" ] || { echo "sync-skills: run from a checkout with plugin.json" >&2; exit 1; }

tmproot="$(mktemp -d)"
trap 'rm -rf "$tmproot"' EXIT

total=0
nprov="$(jq '.providers | length' "$CONFIG")"
pi=0
while [ "$pi" -lt "$nprov" ]; do
  prov="$(jq -c ".providers[$pi]" "$CONFIG")"
  pi=$((pi + 1))

  name="$(printf '%s' "$prov" | jq -r '.name')"
  repo="$(printf '%s' "$prov" | jq -r '.repo')"
  ref="$(printf '%s' "$prov" | jq -r '.ref')"
  license="$(printf '%s' "$prov" | jq -r '.license // "see upstream"')"

  echo "==> $name  ($repo@$ref)"
  clone="$tmproot/$name"
  git clone --quiet --depth 1 --branch "$ref" "https://github.com/$repo" "$clone"
  sha="$(git -C "$clone" rev-parse HEAD)"
  cdate="$(git -C "$clone" log -1 --format=%cI)"

  # Prune everything THIS provider vendored last time (identified by its marker),
  # so removed/renamed/now-excluded skills disappear. Hand-authored skills and
  # other providers' skills (different/absent marker) are never touched.
  for d in "$SKILLS_DIR"/*/; do
    m="${d}${MARKER}"
    [ -f "$m" ] || continue
    if jq -e --arg p "$name" '.provider == $p' "$m" >/dev/null 2>&1; then
      rm -rf "$d"
    fi
  done
  rm -rf "$VENDOR_DIR/$name"
  mkdir -p "$VENDOR_DIR/$name"

  included=""   # space-separated skill names vendored this run
  ncat="$(printf '%s' "$prov" | jq -r '.include_categories | length')"
  ci=0
  while [ "$ci" -lt "$ncat" ]; do
    cat="$(printf '%s' "$prov" | jq -r ".include_categories[$ci]")"
    ci=$((ci + 1))
    catdir="$clone/skills/$cat"
    [ -d "$catdir" ] || { echo "  ! category not found upstream: $cat" >&2; continue; }

    for sk in "$catdir"/*/; do
      sk="${sk%/}"
      [ -f "$sk/SKILL.md" ] || continue
      skname="$(basename "$sk")"

      if printf '%s' "$prov" | jq -e --arg s "$skname" '(.exclude_skills // []) | index($s)' >/dev/null; then
        echo "  - excluded: $skname"
        continue
      fi

      # Collision: a dir already at skills/<skname> (hand-authored, or another
      # provider's — ours were pruned above). Never clobber it.
      if [ -e "$SKILLS_DIR/$skname" ]; then
        echo "  ! SKIPPED (collision): $skname  (already exists in skills/)" >&2
        continue
      fi

      cp -Rp "$sk" "$SKILLS_DIR/$skname"
      printf '{"provider":"%s","repo":"%s","ref":"%s","sha":"%s","upstream":"skills/%s/%s"}\n' \
        "$name" "$repo" "$ref" "$sha" "$cat" "$skname" > "$SKILLS_DIR/$skname/$MARKER"
      included="$included $skname"
      total=$((total + 1))
      echo "  + $skname  (from $cat/)"
    done
  done

  # Optional `skills[]` shape: single explicit path per skill (dual to
  # include_categories — a provider uses one or the other). File -> SKILL.md;
  # directory -> copied recursively. Upstream LICENSE travels INTO the skill
  # dir too (not just vendor/<provider>/), since e.g. herdr is AGPL and the
  # license must accompany the skill when installed via `npx skills add`.
  nskills="$(printf '%s' "$prov" | jq -r '.skills | length')"
  si=0
  while [ "$si" -lt "$nskills" ]; do
    skill="$(printf '%s' "$prov" | jq -c ".skills[$si]")"
    si=$((si + 1))
    skname="$(printf '%s' "$skill" | jq -r '.name')"
    skpath="$(printf '%s' "$skill" | jq -r '.path')"
    srcpath="$clone/$skpath"

    # Collision: same guard as include_categories — never clobber hand-authored
    # or another provider's skill (ours were pruned above).
    if [ -e "$SKILLS_DIR/$skname" ]; then
      echo "  ! SKIPPED (collision): $skname  (already exists in skills/)" >&2
      continue
    fi

    if [ -f "$srcpath" ]; then
      mkdir -p "$SKILLS_DIR/$skname"
      cp -p "$srcpath" "$SKILLS_DIR/$skname/SKILL.md"
    elif [ -d "$srcpath" ]; then
      cp -Rp "$srcpath" "$SKILLS_DIR/$skname"
    else
      echo "  ! path not found upstream: $skpath" >&2
      continue
    fi

    [ -f "$clone/LICENSE" ] && cp "$clone/LICENSE" "$SKILLS_DIR/$skname/LICENSE"
    printf '{"provider":"%s","repo":"%s","ref":"%s","sha":"%s","upstream":"%s"}\n' \
      "$name" "$repo" "$ref" "$sha" "$skpath" > "$SKILLS_DIR/$skname/$MARKER"
    included="$included $skname"
    total=$((total + 1))
    echo "  + $skname  (from $skpath)"
  done

  # Attribution + provenance (top-level vendor/<provider>/, never scanned as a skill).
  [ -f "$clone/LICENSE" ] && cp "$clone/LICENSE" "$VENDOR_DIR/$name/LICENSE"
  names_json="$(printf '%s\n' $included | jq -R . | jq -s 'map(select(length>0)) | sort')"
  jq -n --arg provider "$name" --arg repo "$repo" --arg ref "$ref" \
        --arg sha "$sha" --arg date "$cdate" --argjson skills "$names_json" \
        '{provider:$provider, repo:$repo, ref:$ref, sha:$sha, upstreamCommitDate:$date, skills:$skills}' \
        > "$VENDOR_DIR/$name/manifest.json"
  {
    echo "# Vendored skills — $name"
    echo
    echo "**GENERATED — do not hand-edit.** The skills themselves live flat in \`skills/<name>/\`"
    echo "(each carries a \`.vendored-from\` marker). Regenerated by \`scripts/sync-skills.sh\`."
    echo
    echo "- Source: https://github.com/$repo (ref \`$ref\`)"
    echo "- Commit: \`$sha\`"
    echo "- Upstream commit date: $cdate"
    echo "- License: $license (see [LICENSE](./LICENSE))"
    echo
    echo "## Included skills"
    echo
    for s in $included; do echo "- [\`$s\`](../../skills/$s)"; done
  } > "$VENDOR_DIR/$name/README.md"
done

# The root plugin.json `skills` array is not honored by the loader here; drop it
# if a previous version wrote one (vendored skills now register via auto-discovery).
if jq -e 'has("skills")' plugin.json >/dev/null 2>&1; then
  tmp="$(mktemp)"; jq 'del(.skills)' plugin.json > "$tmp" && mv "$tmp" plugin.json
  echo "note: removed stale .skills array from plugin.json"
fi

echo
echo "Synced $total vendored skill(s) into $SKILLS_DIR/ (flat). Attribution in $VENDOR_DIR/."
