---
status: accepted
closes: "#16"
---

# afk-issue: explicit orchestrator data-flow, audit-only hooks

## Context

A `isolation: worktree` subagent runs on a **harness-named branch** (`agent-<id>`), not on a developer-named branch (`<type>/<N>-<slug>`). This means:

- Issue-number derivation via `sed` on the branch name is dead.
- The `Refs:` trailer approach is dead (the branch name never matches the guard).
- Any hook that tries to reconstruct state from git history or branch name is unreliable.

The old implementation of `afk-issue` relied on hook-written `issue-N.json` state files (written by `afk-handoff.sh`, consumed by `code-reviewer.md`) and a `add-refs-trailer.sh` PostToolUse hook. Both mechanisms break under harness-named branches.

## Decision

Correctness moves **off** hook-reconstructed git state and **onto** explicit orchestrator-held data:

1. **Runner returns explicit data**: the `afk-task-runner` returns its PR#, head branch, worktree path, and test result as its final output. The orchestrator (the `afk-issue` skill) holds this data.

2. **Orchestrator verifies and forwards**: the orchestrator verifies the PR via `gh pr view <n>` (never assumes from a naming convention), then passes PR#/branch explicitly into the code-reviewer prompt and cleanup commands.

3. **Hooks are audit-only / mechanical**: `afk-handoff.sh` posts a completion PR comment and writes **no** state file. `code-reviewer-push.sh` pushes `RALPH:` commits from the reviewer's own worktree. Neither hook is a data channel.

4. **Reviewer is worktree-isolated**: the runner's worktree is freed (via `git worktree remove --force`) before the reviewer spawns, so `gh pr checkout <n>` in the reviewer's own worktree never hits a "branch already checked out" conflict.

5. **`add-refs-trailer.sh` removed**: dead under harness-named branches and `cd`s to the wrong repo for worktree commits. Removed outright; unwired from `hooks.json`.

6. **Preflight is hard**: the `afk-issue` skill hard-checks issue existence, design-lock contract (CONTEXT.md + relevant ADR + "design locked" comment), base-branch on origin, and gh account before spawning anything.

## Consequences

- `issue-N.json` state files are **intentionally dropped** — no longer written, no longer read. Issue #12's "state file survives worktree cleanup" criterion is superseded.
- `add-refs-trailer.sh` is deleted. Issue #13's SIGPIPE edge is resolved by deletion of the block.
- The `code-reviewer` agent uses prompt-passed PR#/branch as its primary source; the old `issue-N.json` tier-1 fallback is removed.
- `CODING_STANDARDS.md` is soft for the reviewer: "apply if present, else general best practices." Its absence is not a preflight failure.
- The test suite (`hooks/tests/test-afk-hooks.sh`) covers the harness-named-branch case (`agent-abc123`) and asserts audit-only `afk-handoff` behavior.
