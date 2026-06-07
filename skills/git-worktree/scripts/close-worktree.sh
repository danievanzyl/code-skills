#!/usr/bin/env bash
#
# close-worktree.sh — merge-gated cleanup after a PR lands.
#
# Tears down a feature branch once its PR is MERGED:
#   1. removes the worktree (worktree layout) OR switches src off the branch (plain clone)
#   2. deletes the LOCAL branch  — `git branch -d`, falling back to `-D` (see below)
#   3. deletes the REMOTE branch — idempotent: a no-op if GitHub auto-deleted it on merge
#   4. prunes stale worktree refs
#
# WHY THE -d -> -D FALLBACK IS SAFE HERE
#   A squash- or rebase-merge rewrites history, so the branch's commits are NOT
#   ancestors of the default branch. `git branch -d` then refuses ("not fully
#   merged") even though the PR genuinely landed — and a naive caller re-prompts
#   forever. This script first PROVES the PR is MERGED via `gh`; only then does it
#   force the delete. The gh gate IS the safety. The force just works around git's
#   local-only view of "merged".
#
# REMOTE DELETE IS BEST-EFFORT
#   GitHub's "auto-delete head branch on merge" usually removed origin/<branch>
#   already, so a plain `push --delete` would error. We check `ls-remote` first
#   and treat "already gone" as success.
#
# Used by the `git-worktree` (close worktree) and `wrap-up` skills. The script
# operates on whatever repo you point --src at, independent of the cwd it runs in.
#
# Exit codes:
#   0  cleaned up
#   2  refused — PR not MERGED (and --allow-abandoned not given)
#   3  refused — uncommitted changes (re-run with --discard-dirty)
#   4  usage / resolution error

set -euo pipefail

usage() {
  cat <<'EOF'
close-worktree.sh — merge-gated branch + worktree cleanup

USAGE
  close-worktree.sh --branch <name> [--src <dir>] [options]

OPTIONS
  --branch <name>     Branch to clean up. Default: current branch in cwd.
  --src <dir>         Main checkout (the worktree-layout `src/` dir, or the plain
                      clone). Default: the main worktree detected from cwd.
  --repo <owner/repo> Repo for the PR check. Default: gh auto-detect from --src.
  --default-branch <name>  Default branch. Default: gh/git auto-detect.
  --allow-abandoned   Permit cleanup when the PR is CLOSED (not merged) or absent.
                      Caller must have the user's explicit OK — this force-deletes
                      unmerged work.
  --discard-dirty     Proceed even if the worktree has uncommitted changes.
  --keep-remote       Do not touch the remote branch.
  -h, --help          Show this help.

The PR-MERGED check is the safety gate; everything destructive runs only after it
passes (or --allow-abandoned is given).
EOF
}

die() { printf 'close-worktree: %s\n' "$1" >&2; exit "${2:-4}"; }

BRANCH="" SRC="" REPO="" DEFAULT_BRANCH=""
ALLOW_ABANDONED=0 DISCARD_DIRTY=0 KEEP_REMOTE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)         BRANCH="${2:?--branch needs a value}"; shift 2 ;;
    --src)            SRC="${2:?--src needs a value}"; shift 2 ;;
    --repo)           REPO="${2:?--repo needs a value}"; shift 2 ;;
    --default-branch) DEFAULT_BRANCH="${2:?--default-branch needs a value}"; shift 2 ;;
    --allow-abandoned) ALLOW_ABANDONED=1; shift ;;
    --discard-dirty)  DISCARD_DIRTY=1; shift ;;
    --keep-remote)    KEEP_REMOTE=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                die "unknown argument: $1" 4 ;;
  esac
done

# --- resolve src (the main checkout we run all git ops against) --------------
if [[ -z "$SRC" ]]; then
  SRC=$(git worktree list --porcelain 2>/dev/null | awk '$1=="worktree"{print $2; exit}') || true
  [[ -n "$SRC" ]] || die "could not detect the main checkout; pass --src <dir>" 4
fi
git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $SRC" 4

# --- resolve branch ---------------------------------------------------------
[[ -n "$BRANCH" ]] || BRANCH=$(git -C "$SRC" branch --show-current)
[[ -n "$BRANCH" ]] || die "could not determine branch; pass --branch <name>" 4

# --- resolve repo + default branch ------------------------------------------
[[ -n "$REPO" ]] || REPO=$( (cd "$SRC" && gh repo view --json nameWithOwner -q .nameWithOwner) 2>/dev/null) || true
if [[ -z "$DEFAULT_BRANCH" ]]; then
  DEFAULT_BRANCH=$( (cd "$SRC" && gh repo view --json defaultBranchRef -q .defaultBranchRef.name) 2>/dev/null) \
    || DEFAULT_BRANCH=$(git -C "$SRC" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@') \
    || true
fi
[[ -n "$DEFAULT_BRANCH" ]] || die "could not determine default branch; pass --default-branch <name>" 4
[[ "$BRANCH" != "$DEFAULT_BRANCH" ]] || die "refusing to delete the default branch ($BRANCH)" 4

# --- the safety gate: PR must be MERGED -------------------------------------
PR_STATE=$( (cd "$SRC" && gh pr view "$BRANCH" ${REPO:+--repo "$REPO"} --json state -q .state) 2>/dev/null) || PR_STATE="NONE"
FORCE_LOCAL=0
case "$PR_STATE" in
  MERGED)
    FORCE_LOCAL=1 ;;
  OPEN)
    die "PR for '$BRANCH' is OPEN — merge it before cleaning up." 2 ;;
  CLOSED)
    [[ $ALLOW_ABANDONED -eq 1 ]] || die "PR for '$BRANCH' is CLOSED (not merged). Re-run with --allow-abandoned to delete it anyway." 2
    FORCE_LOCAL=1 ;;
  *)  # NONE — no PR found, or gh not authenticated
    [[ $ALLOW_ABANDONED -eq 1 ]] || die "no merged PR found for '$BRANCH' (or gh not authenticated). Re-run with --allow-abandoned to delete it anyway." 2
    FORCE_LOCAL=1 ;;
esac

# --- locate the worktree checked out on this branch (if any) ----------------
WT=$(git -C "$SRC" worktree list --porcelain \
      | awk -v b="refs/heads/$BRANCH" '$1=="worktree"{p=$2} $1=="branch"&&$2==b{print p; exit}')
SRC_ABS=$(git -C "$SRC" rev-parse --show-toplevel 2>/dev/null || echo "$SRC")
MODE="inline"
[[ -n "$WT" && "$WT" != "$SRC_ABS" ]] && MODE="worktree"

# --- refuse on uncommitted changes unless told to discard -------------------
DIRTY_TARGET="$SRC"
[[ "$MODE" == "worktree" ]] && DIRTY_TARGET="$WT"
if [[ -n "$(git -C "$DIRTY_TARGET" status --porcelain 2>/dev/null)" && $DISCARD_DIRTY -eq 0 ]]; then
  printf 'close-worktree: %s has uncommitted changes:\n' "$DIRTY_TARGET" >&2
  git -C "$DIRTY_TARGET" status --short >&2
  die "re-run with --discard-dirty to throw them away" 3
fi

# --- tear down --------------------------------------------------------------
WT_RESULT="none (plain clone)"
if [[ "$MODE" == "worktree" ]]; then
  git -C "$SRC" worktree remove --force "$WT"
  WT_RESULT="removed $WT"
else
  # plain clone: get off the branch so it can be deleted
  if [[ "$(git -C "$SRC" branch --show-current)" == "$BRANCH" ]]; then
    git -C "$SRC" checkout "$DEFAULT_BRANCH"
    WT_RESULT="switched src to $DEFAULT_BRANCH"
  fi
fi

# refresh remote-tracking state (drops the stale origin/<branch> ref); best-effort
git -C "$SRC" fetch origin --prune >/dev/null 2>&1 || echo "close-worktree: warning — could not fetch origin (offline?)" >&2

# bring src's default branch up to date so local main reflects the merge; best-effort,
# and only when src is actually on the default branch (always true for the <repo>/src
# layout; in inline mode we switched to it above).
if [[ "$(git -C "$SRC" branch --show-current)" == "$DEFAULT_BRANCH" ]]; then
  git -C "$SRC" pull --ff-only origin "$DEFAULT_BRANCH" >/dev/null 2>&1 || true
fi

# --- delete the local branch (-d, force only after the gate proved it safe) --
if git -C "$SRC" branch -d "$BRANCH" 2>/dev/null; then
  LOCAL_RESULT="deleted (-d, clean merge)"
elif [[ $FORCE_LOCAL -eq 1 ]]; then
  git -C "$SRC" branch -D "$BRANCH"
  LOCAL_RESULT="deleted (-D, forced — squash/rebase merge or abandoned)"
else
  die "branch '$BRANCH' is not fully merged and force not permitted" 2
fi

# --- delete the remote branch (idempotent) ----------------------------------
if [[ $KEEP_REMOTE -eq 1 ]]; then
  REMOTE_RESULT="kept (--keep-remote)"
elif git -C "$SRC" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  git -C "$SRC" push origin --delete "$BRANCH" >/dev/null 2>&1 \
    && REMOTE_RESULT="deleted" \
    || REMOTE_RESULT="FAILED to delete (check manually: git push origin --delete $BRANCH)"
else
  REMOTE_RESULT="already gone (auto-deleted on merge)"
fi

# --- prune + report ---------------------------------------------------------
git -C "$SRC" worktree prune

SRC_HEAD=$(git -C "$SRC" log -1 --oneline 2>/dev/null || echo "?")
cat <<EOF
✓ closed $BRANCH  (PR state: $PR_STATE)
  worktree: $WT_RESULT
  local:    $LOCAL_RESULT
  remote:   $REMOTE_RESULT
  src:      $SRC_ABS @ $SRC_HEAD
EOF
