---
name: gh-draft-pr
description: >-
  Commit any outstanding changes, push the current branch, and open a draft PR via the gh CLI.
  Use this skill whenever the user says "/gh-draft-pr", "open a draft PR", "ship a draft",
  "raise a draft PR", "push and open a PR", or otherwise wants to take their local branch
  from working state to a draft PR on GitHub in one step. Also trigger when the user mentions
  draft PRs, opening a PR for review-not-yet-ready work, or wants their WIP up on GitHub.
allowed-tools: Bash(git *), Bash(gh *), Bash(cat *), Read, Write
---

# GH Draft PR

Take a local branch from working state to a draft PR on GitHub: stage + commit any outstanding changes, push, then open a draft PR.

## Usage

```
/gh-draft-pr [title]
```

- `title` — optional one-line PR title. If omitted, derive from the latest commit subject.

## Workflow

### 1. Sanity checks

Run in parallel:

```bash
git rev-parse --abbrev-ref HEAD          # current branch
git status --porcelain                   # uncommitted changes
gh repo view --json defaultBranchRef -q .defaultBranchRef.name  # base branch
gh pr list --head "$(git rev-parse --abbrev-ref HEAD)" --json number,url,isDraft  # existing PR?
```

Then:

- If current branch == default branch (main/master): stop. Tell the user to switch to a feature branch first — never open PRs from main.
- If `gh pr list` returns a PR: stop. Tell the user the PR already exists with its URL. Don't try to recreate.
- If `gh auth status` fails anywhere: stop and tell the user to run `gh auth login`.

### 2. Commit outstanding changes

If `git status --porcelain` is non-empty:

```bash
git diff --stat                          # see what's changing
git diff --cached --stat                 # already-staged
```

Stage everything tracked + untracked, but **skip likely secrets** (`.env*`, `credentials*`, `*.pem`, `id_rsa*`). If any of those appear in `git status`, ask the user before staging.

```bash
git add -A
```

Generate a commit message from the diff. Style: imperative, concise, follow the repo's existing commit style (run `git log -5 --oneline` to match tone). One subject line, optional body if the change is non-trivial.

```bash
git commit -m "$(cat <<'EOF'
<subject>

<optional body>
EOF
)"
```

If nothing to commit, skip this step.

### 3. Push

```bash
git push -u origin "$(git rev-parse --abbrev-ref HEAD)"
```

`-u` is safe to pass even if upstream already set — it just re-asserts.

### 4. Build PR title and body

**Title:**
- Use the user-provided argument if given.
- Otherwise: latest commit subject (`git log -1 --pretty=%s`).
- Keep under 70 chars.

**Body:** generate from `git log <base>..HEAD` and `git diff <base>..HEAD --stat`. Template:

```
## Summary
<2-3 bullets describing what changed and why — derive from commit subjects + diff>

## Test plan
- [ ] <derive from changed files: tests to add/run>
```

Write to a temp file to avoid shell escaping pain:

```bash
cat > /tmp/gh-draft-pr-body.md << 'EOF'
<body>
EOF
```

### 5. Create the draft PR

```bash
gh pr create --draft --title "<title>" --body-file /tmp/gh-draft-pr-body.md --base "<default-branch>"
```

`gh` infers `--head` from the current branch.

### 6. Confirm

Output the PR URL on a single line. Example:

```
Draft PR opened: https://github.com/owner/repo/pull/123
```

## Rules

- Never use `--no-verify` on commits or `--force` on push unless the user explicitly asks.
- Never commit files matching `.env*`, `credentials*`, `*.pem`, `id_rsa*` without asking.
- Always `--draft` — this skill only opens drafts. If the user wants ready-for-review, they can `gh pr ready` after.
- Always pass body via `--body-file`, never inline.
- Don't open a PR from the default branch.
- Don't recreate a PR if one already exists for the branch — surface the existing URL instead.
- If `gh auth status` fails, stop and tell the user to run `gh auth login`.
