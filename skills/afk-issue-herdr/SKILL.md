---
name: afk-issue-herdr
description: Herdr-native sibling of afk-issue — implements ONE GitHub issue end-to-end by running the afk-task-runner then the code-reviewer, each as a full Claude Code session inside its own herdr pane (not an in-process subagent), opening a reviewed PR. Use when the user says "afk issue #N in herdr", "run issue #N in a herdr pane", "spin up a herdr tab for issue #N", or wants live observability + the ability to intervene mid-run on a single locked-design issue. For the in-process (no herdr) version use afk-issue. Single-issue only — the multi-issue queue/concurrency variant is a deferred follow-up.
argument-hint: <issue-number> [base-branch]
---

# afk-issue-herdr

Herdr-native sibling of `afk-issue`: one targeted issue → `afk-task-runner` → `code-reviewer` → a reviewed PR, same as `afk-issue`, but each agent runs as a **full Claude Code session inside its own herdr pane** instead of an in-process, worktree-isolated subagent. **Orchestration glue, not a reimplementation** — it reuses `afk-task-runner`, `code-reviewer`, and `eval/eval-pr.ts`, and reuses `afk-issue`'s preflight and prompt templates by reference (deltas only, called out below). Do not re-grill the design or re-write the issue here (upstream: `grill-with-docs`, `to-issues`). Design locked in issue #52 / [ADR-0004](../../docs/adr/0004-herdr-pane-orchestration.md) — do not re-derive it from scratch.

`$ARGUMENTS` = `<issue-number> [base-branch]`. Base defaults to `main`.

## Why herdr at all

The driver is **observability + mid-run human intervention + orchestrator↔agent messaging** — you can watch the runner and reviewer work in real time, read their panes, and type into a blocked session to unblock it, none of which the opaque in-process `Task` path offers. A pane-hosted agent being able to spawn its own sub-agents (via its own `Task` tool) is a **latent bonus of running full Claude Code sessions, not the justification** — see "Sub-agent nesting" below.

## Roles (see `CONTEXT.md`)

You are the **Orchestrator**: you select the issue, own the shared worktree, spawn the Runner and Reviewer panes, hold their reported results, invoke the Evaluator per role, and own teardown. You never implement or review yourself. `afk-task-runner` is the Runner; `code-reviewer` is the Reviewer.

## Precondition — must be running inside herdr

This skill drives `herdr` panes from inside a herdr-managed session. Check `HERDR_ENV=1` first (see `skills/herdr/SKILL.md`); if unset, stop and say so — do not try to control panes from outside herdr. If `herdr` binary help output doesn't match `skills/herdr/SKILL.md` + `docs/herdr-binary-notes.md`, treat the notes doc as the current source of truth for anything the vendored SKILL.md is missing (`pane split --cwd`, `pane rename`, `notification`, `worktree`, the `agent` API).

## Parameters — resolve first, never hardcode

| Param              | Source                                                        |
| ------------------ | -------------------------------------------------------------- |
| issue number       | `$ARGUMENTS` (first token)                                     |
| base branch        | `$ARGUMENTS` (second token); default `main`                    |
| owner/repo         | `gh repo view --json nameWithOwner -q .nameWithOwner`           |
| gh account         | memory or `CLAUDE.md` (account routing per org); ask if unknown |
| slug               | kebab-case of the issue title, short (≤ ~40 chars)              |
| branch             | `afk/<N>-<slug>`                                                |
| worktree path      | wherever `herdr worktree create` places it (see Isolation)      |
| report dir         | `~/.afk-herdr/<N>/`                                             |
| PR# + head branch  | the Runner's **report file**, verified via `gh pr view` — never assumed from a naming convention |

## Preflight — fail fast, abort on a missing contract

Same hard gate as `afk-issue`, plus the herdr-specific checks:

- [ ] `HERDR_ENV=1` (above).
- [ ] Issue #N **exists**: `gh issue view N --repo <owner>/<repo>`.
- [ ] Design is **locked**: a "design locked" comment on the issue, plus `CONTEXT.md` / the relevant ADR on the base branch. If not locked → stop, point at `grill-with-docs`.
- [ ] Base branch is **on origin**: `main` is a given; for any other base verify `git ls-remote --exit-code --heads origin <base>`.
- [ ] Correct **gh account** active: `gh auth switch -u <account>`.
- [ ] `~/.afk-herdr/<N>/` doesn't already hold a report from a stale prior run — if it does, confirm with the human before overwriting (a leftover `done` report could make you skip a step you actually need to re-run).

`CODING_STANDARDS.md` is **soft** — the reviewer applies it if present, else general standards. Its absence is not a preflight failure.

## Topology (per-issue structure, "topology C")

One **labeled tab** `issue #N` → **two panes** in sequence (Runner first, then Reviewer), pane-labeled `runner` / `reviewer` → **one shared worktree** on `afk/<N>-<slug>`. Two distinct panes/sessions are required even though they never run concurrently — forced by per-role eval: one `claude` session = one transcript, so a reused pane would blend the Runner Trajectory and Reviewer Trajectory into one.

## Isolation — orchestrator-owned, shared worktree

You (the Orchestrator) own the worktree lifecycle, not the agents:

1. **Prefer `herdr worktree create --branch afk/<N>-<slug> --base <base> --label "issue #N" --json`** over raw `git worktree add` — it is pane-aware (see `docs/herdr-binary-notes.md`). Parse the JSON result for the worktree path and any tab/pane it opened; re-resolve current ids via `herdr tab list` / `herdr pane list` if the response doesn't hand you one directly (ids compact — never assume an id from an earlier call is still valid).
2. If `herdr worktree create` doesn't already give you a labeled tab, create/rename one: `herdr tab rename <tab-id> "issue #N"`.
3. Open both panes **in that worktree** via `--cwd <worktree-path>` on whatever split/agent-start call you use (see below) — never let the Runner or Reviewer create their own worktree.
4. Runner and Reviewer **share** this one worktree. The Reviewer therefore **skips `gh pr checkout` entirely** (kills `feature-branch-fan-in` gotcha 3 by construction) — it inherits the Runner's live tree. Before reviewing, the Reviewer must assert a **clean tree** (`git status --porcelain` empty) and **`HEAD == origin PR head`** (`git rev-parse HEAD` == `gh pr view <pr> --json headRefOid -q .headRefOid`), since it's inheriting a tree it didn't check out itself.

**Open item (non-blocking):** `herdr worktree create`'s own path layout may not match the `git-worktree` skill's `<repo>/<branch>` sibling-directory convention. Use whatever `herdr worktree create` gives you and note the actual path in your report to the human rather than assuming either layout.

## Agent control — prefer the `herdr agent` API

Prefer `herdr agent start <name> --cwd <worktree> --tab <tab-id> --split down -- claude` (+ `agent send`, `agent wait --status`, `agent read`, `agent rename`, `agent release`) over raw `pane split` + `pane run "claude"`. The `agent` API targets by stable name (`runner` / `reviewer`) instead of a pane id that can compact, and herdr already tracks each agent's session/transcript metadata.

1. `herdr agent start runner --cwd <worktree> --tab <tab-id> --split down -- claude` → starts the Runner's Claude Code session. Rename/confirm its pane label is `runner` (`herdr pane rename <pane-id> runner` if `agent start` didn't already label it).
2. Once the session is ready for input (wait for a prompt, e.g. `herdr wait output runner --match ">" --timeout 15000`, mirroring the herdr skill's "spawn a new agent" recipe), `herdr agent send runner "<runner prompt — see below>"`.
3. After the Runner reports done (see Completion detection), start the Reviewer the same way, in the **same tab**, **same worktree**: `herdr agent start reviewer --cwd <worktree> --tab <tab-id> --split down -- claude`, then `herdr agent send reviewer "<reviewer prompt — see below>"`.

## Data channel — report file + sentinel, not terminal-scraping

A pane has no return value, and scraping structured data out of a terminal is fragile. Two independent channels, both told to the agent in its prompt:

- **Payload — report file.** Each agent writes a structured report to an Orchestrator-designated path **outside the worktree**: `~/.afk-herdr/<N>/runner-report.json` / `~/.afk-herdr/<N>/reviewer-report.json`, shape `{pr, branch, transcript_path, test_result, verdict}`. Outside the tree so it never dirties the Runner's working tree or breaks the Reviewer's clean-tree check. The agent **self-reports its own `transcript_path`** — Claude Code names a session's transcript directory after the slugified cwd (`~/.claude/projects/<cwd with "/" → "-">/<session-id>.jsonl`), so the newest `.jsonl` by mtime under that directory at the moment it writes the report is its own. `pane read` / `agent read` are a human observability aid, **never** the data channel.
- **Signal — sentinel.** Each agent's final terminal action prints `<<<AFK_WORK_DONE>>>` on success or `<<<AFK_WORK_BLOCKED>>>` on HITL. Rare token, chosen to avoid false-matching agent prose and absent from the launching command.

## Completion detection — sentinel primary, `agent_status` backstop, watch both

- **Primary gate:** `herdr wait output <name> --match "<<<AFK_WORK_(DONE|BLOCKED)>>>" --regex --timeout <T>` — reliable because it's a deterministic emitted string.
- **Backstop:** `herdr agent get <name>` / `herdr pane list` for `agent_status ∈ {done, blocked}`. `herdr wait agent-status` alone is flaky in practice (timed out in live testing even when the target state was reached) — demote it to corroboration, never the sole gate.
- Watch **both concurrently**, not sentinel-then-status: an agent can go `agent_status: blocked` mid-run (it asked a question) without ever printing the BLOCKED sentinel, and you want to catch that immediately, not after a full timeout. Since you're a sequential CLI-driven agent, "concurrently" means a short-timeout poll loop, not two real threads:

```bash
while true; do
  if herdr wait output "$NAME" --match '<<<AFK_WORK_(DONE|BLOCKED)>>>' --regex --timeout 20000; then
    break   # sentinel matched — inspect which one via `herdr pane read "$NAME" --source recent-unwrapped --lines 10`
  fi
  status=$(herdr agent get "$NAME" | jq -r '.agent_status // .result.agent_status // empty')
  case "$status" in
    blocked) : ;;   # HITL — handle below, then keep looping (never abandon the session)
    done) break ;;  # done with no sentinel — verify the report file next; missing report ⇒ failure
  esac
done
```

- `done` (via either channel) with **no report file at the expected path** is a **failure**, not a success — surface it, don't fabricate a result.

## HITL / blocked handling

On `<<<AFK_WORK_BLOCKED>>>` **or** `agent_status: blocked`:

1. `herdr tab focus <tab-id>` (surface the live session to the human).
2. `herdr notification show "issue #N <role> blocked" --body "<reason from the pane>" --sound request`.
3. Report the reason to the human.
4. **Keep waiting** for `<<<AFK_WORK_DONE>>>` — the human unblocks in-pane and the pipeline resumes; do not tear anything down or abandon the session on a block. Use a generous timeout with a re-notify loop (exact cadence is a non-blocking open item — start conservative, e.g. re-notify every few minutes of continued `blocked`, and tune from experience) so you never wait forever silently.

## Pipeline

1. **Preflight** (above). Abort with a clear report if anything fails.
2. **Create the shared worktree + tab** (Isolation, above): branch `afk/<N>-<slug>` off `<base>`, tab labeled `issue #N`.
3. **Start the Runner pane**, labeled `runner`, `--cwd` the shared worktree; send it the Runner prompt (template below).
4. **Watch for completion** (sentinel + `agent_status` backstop, watch both). Handle any `blocked` per HITL — keep waiting, don't skip ahead.
5. **On Runner done:** read `~/.afk-herdr/<N>/runner-report.json`; if missing, treat as failure and stop. Verify the PR it reports: `gh pr view <pr> --json baseRefName,headRefName` → base = `<base>`, head = the reported branch.
6. **Score the Runner Trajectory:** `bun run eval/scripts/eval-pr.ts --pr <pr> --repo <owner/repo> --transcript <runner transcript_path> --publish` (advisory Scorecard #1 — no `--fail-on-gate`, matching the existing advisory-first rollout).
7. **Start the Reviewer pane**, labeled `reviewer`, `--cwd` the **same** shared worktree (no `gh pr checkout`); send it the Reviewer prompt (template below), which first asserts clean tree + `HEAD == origin PR head`.
8. **Watch for completion** the same way as step 4.
9. **On Reviewer done:** read `~/.afk-herdr/<N>/reviewer-report.json`; if missing, treat as failure and stop.
10. **Score the full Trajectory:** `bun run eval/scripts/eval-pr.ts --pr <pr> --repo <owner/repo> --transcript <runner transcript_path> --reviewer-transcript <reviewer transcript_path> --publish` (Scorecard #2 — now carries the Reviewer's efficiency/security findings alongside the Runner's).
11. **Report** to the human: PR URL, Reviewer verdict (APPROVE / CHANGES MADE / BLOCKED-needs-human), final test result, both Scorecards' gate state, worktree path, tab id.
12. **Teardown Phase 1** (automatic — see below).

Default: **leave the PR open for a human merge**. Merge only on explicit request: `gh pr merge <n> --squash --delete-branch`.

## Deltas from the in-process prompt templates

Reuse `afk-issue`'s [`afk-task-runner` prompt template](../afk-issue/SKILL.md#afk-task-runner-prompt-template) and [`code-reviewer` prompt template](../afk-issue/SKILL.md#code-reviewer-prompt-template) verbatim as the base, **plus** these herdr-specific deltas — a naive pane-hosted port of either template silently breaks:

**Runner delta:**
- You are running **directly in the shared worktree** the Orchestrator already created (`--cwd`) — do NOT create or check out your own worktree; you are not isolated by the harness here.
- Before your final message, self-report your own transcript path (see Data channel, above) and write `~/.afk-herdr/<N>/runner-report.json`: `{pr, branch, transcript_path, test_result, verdict}`.
- Your final terminal output must be exactly `<<<AFK_WORK_DONE>>>` on success or `<<<AFK_WORK_BLOCKED>>>` if you need a human (state the reason just before it).

**Reviewer delta:**
- **Skip `gh pr checkout`.** You are running in the Runner's own worktree, already on the PR's branch. Before reviewing, assert `git status --porcelain` is empty and `git rev-parse HEAD` equals `gh pr view <pr> --json headRefOid -q .headRefOid` — if either fails, stop and report (don't review a tree you can't trust).
- **Push your own commits.** The in-process `code-reviewer-push.sh` hook only fires on the `code-reviewer` `SubagentStop` event — it never fires for you, because you are a top-level pane process whose termination is a `Stop` in your own session, not a `SubagentStop` in the Orchestrator's. After committing `RALPH: Review - …`, run `git push` yourself.
- Same self-report + sentinel contract as the Runner: write `~/.afk-herdr/<N>/reviewer-report.json` and end with `<<<AFK_WORK_DONE>>>` / `<<<AFK_WORK_BLOCKED>>>`.

## Evaluation — orchestrator-driven, per role

The Evaluator (`eval/scripts/eval-pr.ts`) is a read-only CLI, not a spawnable agent. The existing `code-reviewer` `SubagentStop` → `run-evaluator.sh` wiring is **dead here** for the same reason the push hook is dead: pane-hosted agents are top-level processes, so that hook never fires in the Orchestrator. You therefore invoke `eval-pr.ts` yourself, explicitly, per role (pipeline steps 6 and 10) — always passing `--transcript`/`--reviewer-transcript` explicitly from the self-reported report files, never relying on manifest auto-resolution (which tags top-level `Stop` events `role=runner` by default and would mis-tag the Reviewer's own `Stop`). Top-level `Stop` → `capture-run.sh` still fires per-pane and harmlessly links PR→transcript in the manifest; it's inert here since you never read the manifest for control flow.

## Teardown — auto Phase 1, explicit Phase 2

- **Phase 1 (automatic, end of pipeline):** deliver the report, publish both Scorecards, **leave the PR open** for human merge, **leave the tab and worktree in place** for inspection of the completed transcripts.
- **Phase 2 (explicit, only on the human's "done"/wrap-up):**
  1. Close the tab **by its tracked id**: `herdr tab close <tab-id>`.
  2. **Then** remove the worktree: `herdr worktree remove --workspace <id> --force` (or `git worktree remove --force <path>` + `git worktree prune` if you fell back to raw git). Order matters — a worktree can't be removed while a pane's cwd is still inside it. The branch is safe on origin; a human can still `git worktree add`/`gh pr checkout` it later.
- Safety rules (non-negotiable): track child tab/pane ids explicitly as you create them; never blanket-close "non-focused" panes; never assume ownership of the human's focused pane.

## Sub-agent nesting (documented, not exercised by this skill)

Because the Runner and Reviewer are full Claude Code sessions, either can itself use the `Task` tool to spawn its own sub-agents inside its pane (e.g. a focused research sub-agent before making a risky edit) — this "just works" as an ordinary in-process subagent call from within that pane's session, with its own `SubagentStop` firing locally. This skill does not require or orchestrate that nesting; it's a latent capability of running full sessions, not part of the locked pipeline. If you see an agent do this, its own trajectory (and eval) already accounts for it — no special handling needed from the Orchestrator.

## Open items (non-blocking, decide during implementation)

- `herdr worktree create`'s path layout vs the `git-worktree` skill's `<repo>/<branch>` sibling-directory convention — pick whichever `herdr worktree create` actually gives you and report the real path; don't force one convention onto the other.
- HITL keep-waiting timeout + re-notify cadence — start conservative and tune from experience; not fixed by this skill.

## When NOT to use this skill

- **No herdr session** (`HERDR_ENV` unset) → use `afk-issue` (in-process, no observability/intervention).
- **Multiple issues** → `feature-branch-fan-in` (or its herdr variant, once it exists — currently deferred).
- **Design not locked** → `grill-with-docs` first.
- **No issue yet** → `to-issues` first.
