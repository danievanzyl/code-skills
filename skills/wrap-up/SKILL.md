---
name: wrap-up
description: >-
  Post-merge wrap-up: confirm a PR is merged, update local main, close the worktree + branch,
  then offer to write a handoff doc for the next session. Use when the user says "this is merged",
  "merge and clean up", "merged, clean up", "update main and clean up", "wrap up", "done with this PR",
  or "this has been merged, what's next". Closes the worktree/branch itself and chains the handoff
  skill for the doc — do not re-implement the handoff format. For multi-repo work it also flags
  whether a sibling repo's agent now needs a handoff.
argument-hint: "[branch-or-pr] [handoff-topic]"
allowed-tools: Bash(git *), Bash(gh *), Bash(cat *), Read, Write, Skill
---

# wrap-up

The post-merge motion you do by hand every time a PR lands: **confirm merged → update main → close worktree/branch → offer a handoff → say what's next.** Orchestration glue — it closes the worktree/branch itself and leans on `handoff` for the doc, it does not reimplement the handoff format.

`$ARGUMENTS` (both optional):
- `branch-or-pr` — branch name or PR number to wrap up. Default: the current branch / the PR for the current branch.
- `handoff-topic` — if given, skip the "write a handoff?" question and write one with this as the topic.

## When NOT to use this

- PR isn't merged yet → that's `gh-draft-pr` (open) or just wait. This skill refuses on an unmerged PR.
- You only want the handoff doc, no cleanup → call `/handoff` directly.
- Starting new work → create the branch/worktree yourself; this skill only handles post-merge cleanup.

## Resolve first — never hardcode

| Param        | Source                                                              |
| ------------ | ------------------------------------------------------------------ |
| branch       | `$ARGUMENTS` token 1, else `git branch --show-current`             |
| owner/repo   | `gh repo view --json nameWithOwner -q .nameWithOwner`              |
| default branch | `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` |
| src dir      | the `<repo>/src` checkout (worktree layout); else the main checkout |

## Workflow

### 1. Confirm the PR is actually merged

```bash
BRANCH="${1:-$(git branch --show-current)}"
gh pr view "$BRANCH" --json number,state,url -q '"\(.number) \(.state) \(.url)"'
```

- State `MERGED` → proceed.
- State `OPEN` → **stop.** Tell the user it isn't merged; offer `gh-draft-pr` / `gh pr ready` / waiting. Do not clean up.
- State `CLOSED` (not merged) → the work was abandoned. Confirm with the user before deleting anything — they may want to keep the branch.

This is the one hard gate. Everything after destroys local state, so never skip it.

### 2. Close the worktree + branch

The `MERGED` gate from step 1 is what makes the force-delete below safe — refuse to reach this step on an `OPEN` PR, and get explicit user OK for a `CLOSED`/abandoned branch first. Refuse on uncommitted changes unless the user says to discard them (`git status --porcelain` must be empty).

```bash
git checkout "$DEFAULT_BRANCH"
git fetch origin --prune
git pull --ff-only origin "$DEFAULT_BRANCH"

# On the <repo>/src worktree layout, also remove the linked worktree:
git worktree remove <worktree-path>

# Local branch: -d refuses after a squash/rebase merge; the MERGED gate above
# makes -D safe here, so fall back instead of asking.
git branch -d "$BRANCH" 2>/dev/null || git branch -D "$BRANCH"

# Remote branch: only if it survived the merge (auto-delete may have removed it).
git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1 \
  && git push origin --delete "$BRANCH"
```

Report a short summary: worktree removed (if applicable), local branch deleted, remote branch deleted or already gone (that's success, not an error).

### 3. Update local main

Already done above — the `pull --ff-only` in step 2 updated local main. Confirm `git log -1 --oneline` shows the merge.

### 4. Offer the handoff

If `$ARGUMENTS` token 2 (handoff-topic) was given → skip the question, go straight to `/handoff` with that topic.

Otherwise **ask once**: *"Write a handoff doc for the next session? (y / topic / no)"* — don't assume. Small PRs usually don't need one; large-context sessions do (the user's tell: "context is large").

If yes → invoke the **handoff** skill. It writes to the OS temp dir following the convention `/tmp/<os-tmp>/handoff-<topic>.md` (never the workspace), redacts secrets, and includes a "suggested skills" section. Pass the topic through as its argument.

### 5. Report what's next

End with a short status, and — this is the multi-repo payoff — **flag sibling-repo handoffs**. If this PR was part of a cross-repo effort (e.g. an app-instrumentation PR that unblocks a pipeline PR in another repo), say so explicitly and name the downstream agent/repo that now has work. Look for the cue in: the PR body, linked issues (`gh pr view --json closingIssuesReferences`), or any handoff doc you just read this session.

```
Wrapped up #<n> (<branch>) — merged, worktree closed, main at <sha>.
Handoff: <path | none>.
Next: <e.g. "tf-base agent can now pick up #131 (logs tracer-bullet) — its blocker is merged">
```

## Rules

- **Never clean up an unmerged PR.** State must be `MERGED` (or an explicit user OK on a `CLOSED`-abandoned branch).
- Local branch delete: `git branch -d` first, fall back to `-D` only once the PR is confirmed `MERGED` (a squash/rebase merge makes `-d` refuse a branch whose work actually landed — don't keep re-prompting). Never `-D` an unmerged branch without explicit user OK.
- Remote branch delete is idempotent and best-effort: skip it when `ls-remote` shows the branch is already gone (GitHub auto-delete-on-merge). A missing remote branch is success, not an error.
- Never `git push --force` or touch `main` history.
- Handoff docs go to the OS temp dir, never committed to the workspace.
- Don't reimplement the handoff format — invoke the existing `handoff` skill.
- One handoff question, max. If the user said "just clean up", skip the handoff entirely.
