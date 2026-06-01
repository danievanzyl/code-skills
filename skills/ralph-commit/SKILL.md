---
name: ralph-commit
description: >-
  Make a git commit whose message captures key decisions, files changed, and blockers/notes
  for the next iteration. Use when the user says "/ralph-commit", "checkpoint commit",
  "iteration commit", "commit with decisions", or wants to record an iteration's state in
  git before moving on (e.g. inside a ralph loop). Distinct from /commit — this skill
  enforces a structured decisions+files+blockers body.
allowed-tools: Bash(git *), Read, Write
---

# Ralph Commit

Make a single git commit recording the current iteration: key decisions, files changed, and blockers/notes for the next iteration.

## Usage

```
/ralph-commit [subject]
```

- `subject` — optional one-line commit subject. If omitted, derive from the diff.

## Workflow

### 1. Sanity checks

Run in parallel:

```bash
git rev-parse --abbrev-ref HEAD
git status --porcelain
git diff --stat
git diff --cached --stat
git log -5 --oneline
```

- If `git status --porcelain` is empty: stop. Tell the user there is nothing to commit.
- If `.env*`, `credentials*`, `*.pem`, `id_rsa*` appear in status: ask before staging.
- Match commit subject tone to `git log -5 --oneline`.

### 2. Gather iteration context

Decisions and blockers do not live in the diff. Source them from, in order:

1. The current conversation (what the user/you decided this iteration, what is unresolved).
2. Recent assistant turns: deviations from plan, trade-offs taken, things deferred.
3. If still empty: ask the user for one line on decisions and one on blockers. Do not invent.

Files changed: derive from `git status --porcelain` + `git diff --stat` (post-stage).

### 3. Stage

```bash
git add -A
```

Skip secrets as noted above.

### 4. Build the message

**Subject:** user-provided arg, else a concise imperative line derived from the diff. Under 70 chars. Match repo tone.

**Body template** (omit a section only if truly empty after step 2):

```
<subject>

Decisions:
- <decision 1 — what + why, one line>
- <decision 2>

Files:
- <path> — <one-line what changed>
- <path> — <one-line what changed>

Blockers / next iteration:
- <blocker or note, or "none">
```

Rules for the body:

- One bullet per decision/file/blocker. No prose paragraphs.
- Decisions = choices made this iteration, not restatements of the diff.
- Files list mirrors `git diff --cached --name-only`. Group trivially related files if the list is long (>10).
- "Blockers / next iteration" must be present. If nothing is blocked, write `- none`.
- Sacrifice grammar for concision (see project CLAUDE.md).

### 5. Commit

Pass the body via HEREDOC to preserve formatting:

```bash
git commit -m "$(cat <<'EOF'
<subject>

Decisions:
- ...

Files:
- ...

Blockers / next iteration:
- ...
EOF
)"
```

### 6. Confirm

After commit, run `git log -1 --oneline` and echo it on a single line so the user sees the new SHA + subject.

## Rules

- One commit per invocation. Never amend unless the user explicitly asks.
- Never `--no-verify`. If a hook fails, fix the underlying issue and create a new commit.
- Never `git add` files matching `.env*`, `credentials*`, `*.pem`, `id_rsa*` without asking.
- Do not invent decisions or blockers. If the conversation gives nothing, ask the user — one short question — before committing.
- Do not push. This skill only commits.
- No Claude attribution / Co-Authored-By trailers unless the user asks.
