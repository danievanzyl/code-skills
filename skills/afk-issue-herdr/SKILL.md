---
name: afk-issue-herdr
description: Herdr-native sibling of afk-issue — implements ONE GitHub issue end-to-end by running the afk-task-runner then the code-reviewer, each as a full Claude Code session inside its own herdr pane (not an in-process subagent), opening a reviewed PR. Use when the user says "afk issue #N in herdr", "run issue #N in a herdr pane", "spin up a herdr tab for issue #N", or wants live observability + the ability to intervene mid-run on a single locked-design issue. For the in-process (no herdr) version use afk-issue. Single-issue only — the multi-issue queue/concurrency variant is a deferred follow-up.
argument-hint: <issue-number> [base-branch]
---

# afk-issue-herdr

Herdr-native sibling of `afk-issue`: one targeted issue → `afk-task-runner` → `code-reviewer` → a reviewed PR, same as `afk-issue`, but each agent runs as a **full Claude Code session inside its own herdr pane** instead of an in-process, worktree-isolated subagent. **Orchestration glue, not a reimplementation** — it reuses `afk-task-runner`, `code-reviewer`, and `eval/eval-pr.ts`, and reuses `afk-issue`'s preflight and prompt templates by reference (deltas only, called out below). Do not re-grill the design or re-write the issue here (upstream: `grill-with-docs`, `to-issues`). Design locked in issue #52 / [ADR-0004](../../docs/adr/0004-herdr-pane-orchestration.md) — do not re-derive it from scratch.

`$ARGUMENTS` = `<issue-number> [base-branch]`. Base defaults to `main`.

## Why herdr at all

The driver is **observability + mid-run human intervention + orchestrator↔agent messaging** — you can watch the runner and reviewer work in real time, read their panes, and type into a blocked pane agent to unblock it, none of which the opaque in-process `Task` path offers. A pane agent being able to spawn its own sub-agents (via its own `Task` tool) is **not the justification**, but it *is* deliberately preserved — it's the seam for the planned **Engineer** role (`CONTEXT.md`) — which is why the tool policy below keeps `Task` available; see "Sub-agent nesting" below.

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
| workspace id       | from `herdr workspace create --label "afk/<repo>#<N>"` (see Isolation); track it — Phase 2 teardown closes it |
| worktree path      | wherever `herdr worktree create` places it (see Isolation)      |
| report dir         | `~/.afk-herdr/<N>/`                                             |
| runner model       | `model:` in `agents/afk-task-runner.md` (plugin agent def); pass to `claude --model` — see Model, never hardcode |
| reviewer model     | `model:` in `agents/code-reviewer.md` (plugin agent def); pass to `claude --model` — see Model, never hardcode |
| permission flags   | fixed skill policy, both roles: `--permission-mode auto --disallowedTools "WebSearch WebFetch mcp__*"` — see Permissions |
| plugin root        | glob `~/.claude/plugins/cache/*/agentic-platform/*/` → newest; pass to `claude --plugin-dir` (guard hook) — see Permissions, fail loud if unresolvable |
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

**Dedicated workspace** (Orchestrator-created, `afk/<repo>#<N>`) → **one labeled tab** `issue #N` → **two panes** in sequence (Runner first, then Reviewer), pane-labeled `runner` / `reviewer` → **one shared worktree** on `afk/<N>-<slug>`. The workspace is owned by the Orchestrator so teardown closes it wholesale (Teardown, below) without ever touching the human's own panes; single-issue is the N=1 case of the fan-in structure (one workspace, tab-per-issue). Two distinct **pane agents** are required even though they never run concurrently — forced by per-role eval: one Claude Code session = one transcript, so a reused pane would blend the Runner Trajectory and Reviewer Trajectory into one.

## Isolation — orchestrator-owned workspace + shared worktree

You (the Orchestrator) own the **workspace** and the worktree lifecycle, not the agents:

1. **Create the dedicated workspace first:** `herdr workspace create --label "afk/<repo>#<N>" --no-focus --json` → keep `result.workspace` (its id). Everything below is scoped to this workspace via `--workspace <id>`. `--no-focus` so you don't yank the human off their current context; the explicit `--label` avoids colliding with herdr's default repo-name labelling (two AFK runs on one repo would otherwise share a name). Track this id — Phase 2 teardown closes the workspace by it.
2. **Create the shared worktree in that workspace:** prefer `herdr worktree create --workspace <workspace-id> --branch afk/<N>-<slug> --base <base> --label "issue #N" --json` over raw `git worktree add` — it is pane-aware (see `docs/herdr-binary-notes.md`). Parse the JSON result for the worktree path and any tab/pane it opened; re-resolve current ids via `herdr tab list --workspace <workspace-id>` / `herdr pane list` if the response doesn't hand you one directly (ids compact — never assume an id from an earlier call is still valid).
3. If `herdr worktree create` doesn't already give you a labeled tab, create/rename one in the workspace: `herdr tab create --workspace <workspace-id> --label "issue #N"` (or `herdr tab rename <tab-id> "issue #N"`).
4. Open both panes **in that worktree** via `--cwd <worktree-path>` (and `--tab <tab-id>` in the dedicated workspace) on whatever agent-start call you use (see below) — never let the Runner or Reviewer create their own worktree.
5. Runner and Reviewer **share** this one worktree. The Reviewer therefore **skips `gh pr checkout` entirely** (kills `feature-branch-fan-in` gotcha 3 by construction) — it inherits the Runner's live tree. Before reviewing, the Reviewer must assert a **clean tree** (`git status --porcelain` empty) and **`HEAD == origin PR head`** (`git rev-parse HEAD` == `gh pr view <pr> --json headRefOid -q .headRefOid`), since it's inheriting a tree it didn't check out itself.

**Open item (non-blocking):** `herdr worktree create`'s own path layout may not match the `git-worktree` skill's `<repo>/<branch>` sibling-directory convention. Use whatever `herdr worktree create` gives you and note the actual path in your report to the human rather than assuming either layout.

## Agent control — prefer the `herdr agent` API

Prefer `herdr agent start <name> --cwd <worktree> --tab <tab-id> --split down -- claude <launch flags>` (+ `agent send`, `agent wait --status`, `agent read`, `agent rename`) over raw `pane split` + `pane run "claude"`. The `agent` API targets by stable name (`runner` / `reviewer`) instead of a pane id that can compact, and herdr already tracks each pane agent's session/transcript metadata. `<launch flags>` = the role's pinned `--model` (see "Model") **plus** the permission flags (see "Permissions") — resolved per launch, never hardcoded. **Never launch a bare `-- claude`** (silently runs the interactive default model *and* full, unguarded permissions/tools — both diverge from the agent def).

**Names resolve for `agent` subcommands only.** `agent get/read/send/rename/wait/focus/attach` all accept the stable name (`runner`/`reviewer`). `pane read`, `wait output`, and `wait agent-status` do **not** — they require the literal pane id, and error `pane_not_found` on a bare agent name. Capture the pane id from `agent start`'s JSON response (`result.agent.pane_id`) — or re-resolve it later via `herdr agent get <name>` → `.agent.pane_id` — and use that id anywhere you'd otherwise pass the name to `pane`/`wait` commands.

### Model — pin per role from the agent defs, never bare `claude`

A fresh `claude` session in a pane does **not** read agent `.md` frontmatter — only the `Task` tool does. So a bare `-- claude` silently runs the interactive default model, diverging from in-process `afk-issue` (which honours the frontmatter) and **breaking the Efficiency dimension** (`CONTEXT.md`: a Run's cost is only meaningful compared against like work — the herdr and in-process Runs of the same issue must run the *same* model). Pin each role explicitly:

- **Source of truth = the agent def, resolved at runtime — do not hardcode.** Read `model:` from the plugin's `agents/afk-task-runner.md` (Runner) and `agents/code-reviewer.md` (Reviewer) — the same files `afk-issue`'s `Task` tool reads — and pass it verbatim to `claude --model`. Locate them via `${CLAUDE_PLUGIN_ROOT}/agents/<name>.md` (the hooks' convention; fall back to the plugin cache dir if unset). `--model` accepts the alias as-is (e.g. `sonnet`) or a full id (e.g. `claude-sonnet-5`). This keeps herdr auto-synced with `afk-issue` — change the def once, both variants follow.
- **Fail loud.** If you can't resolve a role's `model:`, **stop and report** — do not fall back to bare `claude`; that silently reintroduces the drift this section exists to kill.
- **Orchestrator (your own session):** run it on `opus` — its job is coordination, HITL, and reading Scorecards, not implementation. This skill can't set it retroactively; it's the model you *launch* the Orchestrating session with, so start it on `opus` deliberately rather than by default.

### Permissions — uniform launch policy, never a bare interactive `claude`

A pane agent is **attended-but-idle**: a human can watch and unblock it, but must not have to approve every tool call — so the mode must not stall, yet must not hand the pane unguarded full autonomy in a shared worktree. This is a **skill-level launch policy**, identical for both roles (unlike `--model`, it is *not* read from agent-def frontmatter — a pane agent can't read frontmatter, the values don't vary per role, and under `auto` an allow-list is a no-op anyway). The three flags appended to every launch:

- **`--permission-mode auto`** — the only non-stalling mode: it auto-approves tool calls (so the Runner's `git`/test/`gh` commands don't block) while a background safety classifier still gates destructive shell commands. **Never** `bypassPermissions` / `--dangerously-skip-permissions` (that is the "isolated container only" mode and may also neuter the guard hook's deny) and **never** `--allow-dangerously-skip-permissions` (it only puts bypass one keystroke away in the `Shift+Tab` cycle). Do not pass `--bare` — it strips hooks/plugins entirely (see below).
- **`--disallowedTools "WebSearch WebFetch mcp__*"`** — bare tool names, so those tools are *removed from the pane agent's context* (deny wins even under `auto`; an allow-list would not bite). Shrinks blast radius by cutting network + the human's inherited MCP servers (Atlassian/pencil/playwright — an AFK coder has no business there). `Task` is **deliberately kept** (the Engineer seam — see Sub-agent nesting); this matches the agent defs' `tools:` set, which is also web/MCP-free.
- **`--plugin-dir <plugin-root>`** — loads the `agentic-platform` plugin (its `PreToolUse` `guard-sensitive-files.sh` hook) into the pane unconditionally. The hook otherwise fires *only* if the plugin happens to be enabled at user level, and the pane's `--cwd` is the **target repo's** worktree (whose project settings don't enable this plugin) — so relying on ambient enablement would make repo-agnostic secret-guarding depend on invisible config. Resolve `<plugin-root>` the same way as the agent defs (glob `~/.claude/plugins/cache/*/agentic-platform/*/` → newest version; `${CLAUDE_PLUGIN_ROOT}` is empty in an interactive shell). **Fail loud** if unresolvable — never launch a pane whose guard hook isn't guaranteed.

> The guard hook covers **secret-path** reads/writes only (`.aws`, `.ssh`, `.env`, keys, `.tfstate`) — it is *not* a destructive-command guard. Protection against `rm -rf`/force-push comes from `auto`'s classifier, which is why `auto` (not `dontAsk`, which has no classifier) is the mode.

1. `herdr agent start runner --cwd <worktree> --tab <tab-id> --split down -- claude --model <runner model> --permission-mode auto --disallowedTools "WebSearch WebFetch mcp__*" --plugin-dir <plugin-root>` → starts the Runner pane agent. Parse `result.agent.pane_id` from the response and keep it (needed for `wait output`/`pane read` below). Rename/confirm its pane label is `runner` (`herdr pane rename <pane-id> runner` if `agent start` didn't already label it).
2. Once the pane agent is ready for input (wait for a prompt, e.g. `herdr wait output <runner-pane-id> --match ">" --timeout 15000`, mirroring the herdr skill's "spawn a new agent" recipe), `herdr agent send runner "<runner prompt — see below>"`.
3. After the Runner reports done (see Completion detection), start the Reviewer the same way, in the **same tab**, **same worktree**, with the **same permission flags**: `herdr agent start reviewer --cwd <worktree> --tab <tab-id> --split down -- claude --model <reviewer model> --permission-mode auto --disallowedTools "WebSearch WebFetch mcp__*" --plugin-dir <plugin-root>` (capture its `pane_id` too), then `herdr agent send reviewer "<reviewer prompt — see below>"`.

## Data channel — report file + sentinel, not terminal-scraping

A pane has no return value, and scraping structured data out of a terminal is fragile. Two independent channels, both told to the agent in its prompt:

- **Payload — report file.** Each agent writes a structured report to an Orchestrator-designated path **outside the worktree**: `~/.afk-herdr/<N>/runner-report.json` / `~/.afk-herdr/<N>/reviewer-report.json`, shape `{pr, branch, transcript_path, test_result, verdict}`. Outside the tree so it never dirties the Runner's working tree or breaks the Reviewer's clean-tree check. The agent **self-reports its own `transcript_path`** — Claude Code names a session's transcript directory after the slugified cwd (`~/.claude/projects/<cwd with "/" → "-">/<session-id>.jsonl`), so the newest `.jsonl` by mtime under that directory at the moment it writes the report is its own. `pane read` / `agent read` are a human observability aid, **never** the data channel.
- **Signal — sentinel.** Each agent's final terminal action prints `<<<AFK_WORK_DONE>>>` on success or `<<<AFK_WORK_BLOCKED>>>` on HITL. Rare token, chosen to avoid false-matching agent prose and absent from the launching command.

## Completion detection — sentinel primary, `agent_status` backstop, watch both

- **Primary gate:** `herdr wait output <pane-id> --match "<<<AFK_WORK_(DONE|BLOCKED)>>>" --regex --timeout <T>` — reliable because it's a deterministic emitted string. `wait output` takes the literal pane id, not the agent name (see "Names resolve for `agent` subcommands only" above) — use the `pane_id` you captured from `agent start`.
- **Backstop:** `herdr agent get <name>` / `herdr pane list` for `agent_status ∈ {done, blocked}`. `herdr wait agent-status` alone is flaky in practice (timed out in live testing even when the target state was reached) — demote it to corroboration, never the sole gate. (`agent get` accepts the name; `wait agent-status` needs the pane id, same split as `wait output`.)
- Watch **both concurrently**, not sentinel-then-status: an agent can go `agent_status: blocked` mid-run (it asked a question) without ever printing the BLOCKED sentinel, and you want to catch that immediately, not after a full timeout. Since you're a sequential CLI-driven agent, "concurrently" means a short-timeout poll loop, not two real threads:

```bash
# $NAME = agent name ("runner"/"reviewer"); $PANE_ID = its pane id, captured
# from `agent start`'s result.agent.pane_id (or re-resolved via `agent get`).
while true; do
  if herdr wait output "$PANE_ID" --match '<<<AFK_WORK_(DONE|BLOCKED)>>>' --regex --timeout 20000; then
    break   # sentinel matched — inspect which one via `herdr pane read "$PANE_ID" --source recent-unwrapped --lines 10`
  fi
  status=$(herdr agent get "$NAME" | jq -r '.agent_status // .result.agent_status // empty')
  case "$status" in
    blocked) : ;;   # HITL — handle below, then keep looping (never abandon the pane agent)
    done) break ;;  # done with no sentinel — verify the report file next; missing report ⇒ failure
  esac
done
```

- `done` (via either channel) with **no report file at the expected path** is a **failure**, not a success — surface it, don't fabricate a result.

## HITL / blocked handling

On `<<<AFK_WORK_BLOCKED>>>` **or** `agent_status: blocked`:

1. `herdr tab focus <tab-id>` (surface the live pane agent to the human).
2. `herdr notification show "issue #N <role> blocked" --body "<reason from the pane>" --sound request`.
3. Report the reason to the human.
4. **Keep waiting** for `<<<AFK_WORK_DONE>>>` — the human unblocks in-pane and the pipeline resumes; do not tear anything down or abandon the pane agent on a block. Use a generous timeout with a re-notify loop (exact cadence is a non-blocking open item — start conservative, e.g. re-notify every few minutes of continued `blocked`, and tune from experience) so you never wait forever silently.

## Pipeline

1. **Preflight** (above). Abort with a clear report if anything fails.
2. **Create the dedicated workspace, then the shared worktree + tab** (Isolation, above): workspace `afk/<repo>#<N>`, branch `afk/<N>-<slug>` off `<base>`, tab labeled `issue #N`. Track the workspace id.
3. **Start the Runner pane**, labeled `runner`, `--cwd` the shared worktree, with the model + permission flags (Agent control); send it the Runner prompt (template below).
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

- **Phase 1 (automatic, end of pipeline):** deliver the report, publish both Scorecards, **leave the PR open** for human merge, **leave the workspace (tab + panes) and worktree in place** for inspection of the completed transcripts.
- **Phase 2 (explicit, only on the human's "done"/wrap-up):**
  1. Close the whole workspace **by its tracked id**: `herdr workspace close <workspace-id>`. Because the workspace is Orchestrator-owned and dedicated, this reclaims its tabs + panes atomically — no per-tab tracking, and no risk of touching the human's own panes.
  2. **Then** remove the worktree: `herdr worktree remove --workspace <workspace-id> --force` (or `git worktree remove --force <path>` + `git worktree prune` if you fell back to raw git). Order matters — a worktree can't be removed while a pane's cwd is still inside it, and closing the workspace first frees it. The branch is safe on origin; a human can still `git worktree add`/`gh pr checkout` it later.
- Safety rules (non-negotiable): the Orchestrator only ever closes the **workspace it created** (by tracked id); never blanket-close "non-focused" panes; never close a workspace or pane you did not create; never assume ownership of the human's focused pane.

## Sub-agent nesting (deliberately preserved, not yet exercised)

Because the Runner and Reviewer are full Claude Code sessions, either can itself use the `Task` tool to spawn its own sub-agents inside its pane — this "just works" as an ordinary in-process subagent call from within that pane agent's session, with its own `SubagentStop` firing locally. **This is why the permission policy keeps `Task` available** (it denies web + MCP but not `Task`): it's the seam for the planned **Engineer** role (`CONTEXT.md`; tracked in #63) — a specialized implementer the Runner/Reviewer will delegate risky slices to. This skill does not yet require or orchestrate that nesting; today's locked prompts never invoke it, so keeping `Task` available is latent, not active.

**Efficiency-parity caveat for whoever wires Engineer in:** the in-process agent defs (`agents/afk-task-runner.md`, `agents/code-reviewer.md`) grant `tools:` with **no `Task`**, so the in-process `afk-issue` Runner currently *cannot* nest. If pane agents start nesting but the in-process ones can't, the two variants' Trajectories diverge and the **Efficiency dimension** comparison between them breaks (the same reason `--model` is pinned). So add the Engineer capability to **both** variants together — grant `Task` in the agent defs and teach both prompts to use it — never to the pane path alone.

## Open items (non-blocking, decide during implementation)

- `herdr worktree create`'s path layout vs the `git-worktree` skill's `<repo>/<branch>` sibling-directory convention — pick whichever `herdr worktree create` actually gives you and report the real path; don't force one convention onto the other.
- HITL keep-waiting timeout + re-notify cadence — start conservative and tune from experience; not fixed by this skill.

## When NOT to use this skill

- **No herdr session** (`HERDR_ENV` unset) → use `afk-issue` (in-process, no observability/intervention).
- **Multiple issues** → `feature-branch-fan-in` (or its herdr variant, once it exists — currently deferred).
- **Design not locked** → `grill-with-docs` first.
- **No issue yet** → `to-issues` first.
