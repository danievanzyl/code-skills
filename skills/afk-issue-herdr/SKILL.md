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
| agent names        | `RUNNER_NAME=runner-<tab_id>` / `REVIEWER_NAME=reviewer-<tab_id>`, `:`→`-` sanitized, resolved once from `result.tab.tab_id` (see Isolation step 2) — the herdr **agent name**; distinct from the pane **label** (`runner`/`reviewer`, unqualified, human-facing) |
| workspace id       | `result.worktree.open_workspace_id` from `herdr worktree create` (see Isolation); track it — Phase 2 teardown closes it |
| worktree path      | `result.worktree.path` from `herdr worktree create` — canonically `~/.herdr/worktrees/<repo>/<branch>` (see Isolation) |
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
- [ ] **Workspace-trust repo root is accepted** (see "Workspace trust" below): the worktree's **git repo root** (`git rev-parse --path-format=absolute --git-common-dir` from the target repo → its parent) has `hasTrustDialogAccepted: true` under `.projects["<path>"]` in `~/.claude.json`. If not → **warn**, don't stop — note that the defensive per-run fallback (below) will catch any dialog anyway, and proceed to Isolation. Do not mutate `~/.claude.json` yourself.

`CODING_STANDARDS.md` is **soft** — the reviewer applies it if present, else general standards. Its absence is not a preflight failure.

## Topology (per-issue structure, "topology C")

**Dedicated workspace** (Orchestrator-created, `afk/<repo>#<N>`) → **one labeled tab** `issue #N` → **two panes** in sequence (Runner first, then Reviewer), pane-labeled `runner` / `reviewer` (human-facing, tab-local — distinct from the qualified herdr **agent names**, `runner-<tab_id>`/`reviewer-<tab_id>`; see Isolation step 2) → **one shared worktree** on `afk/<N>-<slug>`. The workspace is owned by the Orchestrator so teardown closes it wholesale (Teardown, below) without ever touching the human's own panes; single-issue is the N=1 case of the fan-in structure (one workspace, tab-per-issue). Two distinct **pane agents** are required even though they never run concurrently — forced by per-role eval: one Claude Code session = one transcript, so a reused pane would blend the Runner Trajectory and Reviewer Trajectory into one.

## Isolation — worktree-first (do not pre-create a workspace)

You (the Orchestrator) own the workspace and worktree lifecycle, not the agents. **Worktree-first, not workspace-first** — live-verified against herdr 0.7.1: `herdr worktree create` **ignores `--workspace`** for placement (it always spawns its own workspace, making a pre-made one dead weight), and an empty workspace with no running agent is **auto-reaped as idle** before an agent can be pinned to it. A pre-made workspace is therefore both useless and actively dangerous (it can die mid-run). The verified sequence:

1. **Resolve all launch flags and write both prompt files first**, before touching herdr at all — role models (see "Model"), permission flags (see "Permissions"), plugin root, and the full Runner/Reviewer prompt text, saved to files. Do this *before* step 2 so `worktree create → agent start` is seconds, not minutes: idle-reaping killed a workspace mid-run when prompt composition took several minutes after workspace creation.
2. **Create the worktree** (this also creates its own workspace, tab, and root pane): `herdr worktree create --cwd <target-repo> --branch afk/<N>-<slug> --base <base> --label "issue #N" --json`. **`--cwd <target-repo>` is mandatory** — your own Orchestrator cwd may be a different repo, and an omitted/wrong `--cwd` mis-anchors the worktree (verified: cost a recreate in the live shakedown). Parse the single JSON result for everything you need: `result.worktree.path` (worktree path), `result.worktree.open_workspace_id` (workspace id), `result.tab.tab_id` (tab id), `result.root_pane.pane_id` (the spare root pane — closed in Agent control, below). **Resolve the qualified agent names here too, once:** `RUNNER_NAME=runner-<tab_id>` / `REVIEWER_NAME=reviewer-<tab_id>`, sanitizing `:`→`-` in the tab-id suffix (herdr agent names are a **global** namespace, not scoped per workspace/tab — see ADR-0004 Consequences — so the bare names `runner`/`reviewer` collide across any two concurrent herdr AFK runs; `tab_id` embeds the globally-unique workspace id, so this is unique at one-pipeline-per-tab granularity). Use `$RUNNER_NAME`/`$REVIEWER_NAME` at every subsequent name-passing call site (Agent control, Permissions, Completion detection). Pane **labels** (`runner`/`reviewer`) are a separate, tab-local, human-facing concern and stay unqualified — do not conflate the two.
3. **Adopt, don't recreate, the workspace:** `herdr workspace rename <workspace-id> "afk/<repo>#<N>"`. Do **not** call `herdr workspace create` separately — the workspace from step 2 *is* the dedicated workspace; renaming it is the whole "creation" step.
4. **Start the Runner immediately** (Agent control, below) so the workspace is never idle-empty between steps 2 and the Runner's first tool call.
5. Runner and Reviewer **share** this one worktree. The Reviewer therefore **skips `gh pr checkout` entirely** (kills `feature-branch-fan-in` gotcha 3 by construction) — it inherits the Runner's live tree. Before reviewing, the Reviewer must assert a **clean tree** (`git status --porcelain` empty) and **`HEAD == origin PR head`** (`git rev-parse HEAD` == `gh pr view <pr> --json headRefOid -q .headRefOid`), since it's inheriting a tree it didn't check out itself.

Worktree layout is `~/.herdr/worktrees/<repo>/<branch>` — a de-facto `<repo>/<branch>` sibling layout; adopt it as canonical and stop hedging on it.

## Workspace trust — dialog preflight + defensive fallback

Every AFK pane launches `claude` in a **fresh, untrusted worktree path**, so claude shows the "Do you trust the files in this folder?" dialog **before** the REPL. `-p` would skip it but kills interactivity, which this skill needs. Live-verified: text sent to the pane before the dialog is accepted is **silently swallowed** — a naive Runner/Reviewer launch hangs here forever. There is **no settings key / env var / non-dangerous flag** that persists trust (checked against claude CLI 2.1.204). Trust is resolved by **git repo root, not worktree-dir ancestry**: a linked worktree inherits its main checkout's trust. Empirically re-verified (#68) against the actual pipeline runs: #65 and #67 both launched `claude` in fresh `~/.herdr/worktrees/code-skills/*` worktrees with **zero trust dialog**, and `~/.claude.json` has **no `~/.herdr/worktrees*` entry at all** — only `.projects["/Users/danievanzyl/code/play/code-skills"].hasTrustDialogAccepted: true` (the main checkout, the git repo root every worktree of this repo derives from). Trust state lives at `~/.claude.json` → `.projects["<path>"].hasTrustDialogAccepted`, keyed by that repo root; an untrusted worktree path still inherits its trusted repo root. (Caveat: an earlier standalone shakedown, a throwaway worktree of a different, untrusted repo, did show the dialog — consistent with the repo-root theory, since that repo's root had never been trusted.)

- **Preflight (soft warn, see Preflight above):** before creating anything, resolve the worktree's git repo root (`git rev-parse --path-format=absolute --git-common-dir` on the target repo, then its parent) and check whether it already has `hasTrustDialogAccepted: true` in `~/.claude.json`. If not, **warn** — note the defensive per-run fallback below will catch any dialog — and proceed to Isolation regardless; a false negative here must not block an otherwise-valid run. Never mutate `~/.claude.json` yourself.
- **Defensive per-run fallback (the real hang guard):** immediately after each `agent start`, before waiting for readiness, check `herdr pane read <pane-id>` for the trust prompt (match `trust this folder`). If present: `herdr pane send-keys <pane-id> Enter` (option 1, "Yes, I trust", is pre-selected — verified Enter accepts it), then proceed to the readiness wait as normal. This should rarely fire once the repo root is trusted, but guarantees no silent hang regardless of what the preflight warn found.

## Agent control — prefer the `herdr agent` API

Prefer `herdr agent start <name> --workspace <workspace-id> --tab <tab-id> --cwd <worktree> [--split right|down] -- claude <launch flags>` (+ `agent send`, `agent wait --status`, `agent read`, `agent rename`) over raw `pane split` + `pane run "claude"`. The `agent` API targets by stable name (the qualified `$RUNNER_NAME`/`$REVIEWER_NAME`, resolved once per run — see Isolation step 2) instead of a pane id that can compact, and herdr already tracks each pane agent's session/transcript metadata. `<launch flags>` = the role's pinned `--model` (see "Model") **plus** the permission flags (see "Permissions") — resolved per launch, never hardcoded. **Never launch a bare `-- claude`** (silently runs the interactive default model *and* full, unguarded permissions/tools — both diverge from the agent def).

**`--cwd <worktree>` is mandatory on every `agent start` call, no exceptions.** Live-verified: without it, a pane lands in a default directory (e.g. `~/…/ritdu`), **not** the worktree — and a `--split` pane does **not** inherit its origin pane's cwd, so it needs its own explicit `--cwd` too.

**`herdr agent start` always creates its own new pane**, even without `--split` — it never reuses an existing one (live-verified). `herdr worktree create` (Isolation, above) leaves behind a spare idle root pane, so the topology needs one cleanup step to end up with exactly one pane per role:

- **Runner:** `herdr agent start $RUNNER_NAME --workspace <workspace-id> --tab <tab-id> --cwd <worktree> -- claude <launch flags>`. **Close the spare root pane only after this returns a parseable `result.agent.pane_id`** — `herdr pane close <root-pane-id>` (the spare root pane from `worktree create`). On a **failed start** (no parseable `pane_id`): do **not** close the root pane; run clean teardown (`herdr worktree remove --workspace <workspace-id> --force`) and stop with a loud report — see "Hardening — gate root-pane close on start success" below. Verified: `herdr agent get $RUNNER_NAME` still resolves correctly after the root pane is closed — one clean pane, name API intact.
- **Reviewer:** `herdr agent start $REVIEWER_NAME --workspace <workspace-id> --tab <tab-id> --split right --cwd <worktree> -- claude <launch flags>`. **`--split right`** (vertical divider, side-by-side with the Runner's pane) — not `--split down`. **On a failed start** (no parseable `result.agent.pane_id`): same failure handling as the Runner — clean teardown (`herdr worktree remove --workspace <workspace-id> --force`) and stop with a loud report, no collision-retry; there's just no root pane to withhold closing this time (only `worktree create` leaves one, and that was already closed after the Runner's start).

### Hardening — gate root-pane close on start success, no retry

The original ordering — `agent start` then unconditionally `pane close <root-pane-id>` — assumed the start succeeds. It doesn't always: a failed start left the root pane closed anyway, stranding an empty workspace that herdr idle-reaps (Isolation, above) before anyone notices — the #73 cascade. Fixed order: close the root pane **only after** `agent start` returns a parseable `result.agent.pane_id`. On a failed start: clean teardown now, immediately — `herdr worktree remove --workspace <workspace-id> --force` — then stop and report loudly to the human; do not proceed to the Reviewer. **No collision-retry loop** — `$RUNNER_NAME`/`$REVIEWER_NAME` are unique per tab by construction, so a start failure here is a real error (not a name collision), and retrying it blindly would be dead code.

**Names resolve for `agent` subcommands only.** `agent get/read/send/rename/wait/focus/attach` all accept the stable name (the qualified `$RUNNER_NAME`/`$REVIEWER_NAME`). `pane read`, `pane send-keys`, `wait output`, and `wait agent-status` do **not** — they require the literal pane id, and error `pane_not_found` on a bare agent name. Capture the pane id from `agent start`'s JSON response (`result.agent.pane_id`) — or re-resolve it later via `herdr agent get <name>` → `.agent.pane_id` — and use that id anywhere you'd otherwise pass the name to `pane`/`wait` commands.

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

1. `herdr agent start $RUNNER_NAME --workspace <workspace-id> --tab <tab-id> --cwd <worktree> -- claude --model <runner model> --permission-mode auto --disallowedTools "WebSearch WebFetch mcp__*" --plugin-dir <plugin-root>` → starts the Runner pane agent. Parse `result.agent.pane_id`. **Only if it parses** (successful start): keep it (needed for `pane`/`wait` commands below) and close the spare root pane, `herdr pane close <root-pane-id>` (Topology cleanup, above; Hardening, above). **If it doesn't parse** (failed start): do not close the root pane — run `herdr worktree remove --workspace <workspace-id> --force` and stop with a loud report; do not proceed to step 2.
2. **Trust check** (defensive fallback, above): `herdr pane read <runner-pane-id>`; if it shows the trust prompt, `herdr pane send-keys <runner-pane-id> Enter`.
3. **Readiness:** `herdr agent wait $RUNNER_NAME --status idle --timeout 30000` — live-verified this correctly detects the booted claude session with no glyph-guessing (the old `wait output --match ">"` readiness check is wrong: the real prompt glyph is `❯`, not `>`, so it never matched).
4. **Send:** `herdr agent send $RUNNER_NAME "$(cat <runner-promptfile>)"` — verified `agent send` uses bracketed paste and lands a full multi-line prompt intact with no early submit. This is why the prompt is kept in a file (per Isolation step 1) rather than composed inline — a `pane run` text+Enter approach submits per newline and is wrong here.
5. **Submit:** `herdr pane send-keys <runner-pane-id> Enter`, then confirm `herdr agent get $RUNNER_NAME` transitions to `agent_status: working` and the input area clears.
6. **Verify-and-resend:** `herdr pane read <runner-pane-id>` the input area; if the prompt text is still sitting unsent, re-send `herdr pane send-keys <runner-pane-id> Enter` (bounded retries, e.g. 3, with a short pause between) — encodes the "Enter didn't land" recovery done by hand in the live shakedown.
7. After the Runner reports done (see Completion detection), start the Reviewer the same way, in the **same tab**, **same worktree**, with the **same permission flags**: `herdr agent start $REVIEWER_NAME --workspace <workspace-id> --tab <tab-id> --split right --cwd <worktree> -- claude --model <reviewer model> --permission-mode auto --disallowedTools "WebSearch WebFetch mcp__*" --plugin-dir <plugin-root>`. Parse `result.agent.pane_id` the same way as step 1: if it doesn't parse (failed start), run the same failure handling — `herdr worktree remove --workspace <workspace-id> --force` and stop with a loud report; no root pane to preserve this time (it's already closed). **Only if it parses:** capture the `pane_id` (no root pane to close this time, only the Runner's `worktree create` leaves one), then repeat steps 2–6 for the Reviewer (`herdr agent wait $REVIEWER_NAME --status idle`, `herdr agent send $REVIEWER_NAME "$(cat <reviewer-promptfile>)"`, `herdr pane send-keys <reviewer-pane-id> Enter`, verify-and-resend).

## Data channel — report file is the payload, sentinel is a human cue only

A pane has no return value, and scraping structured data out of a terminal is fragile. Two channels, both told to the agent in its prompt, are **not peers** — one is the machine gate, the other is for the human's eyes only:

- **Payload — report file (the machine gate).** Each agent writes a structured report to an Orchestrator-designated path **outside the worktree**: `~/.afk-herdr/<N>/runner-report.json` / `~/.afk-herdr/<N>/reviewer-report.json`, shape `{pr, branch, transcript_path, test_result, verdict}`. Outside the tree so it never dirties the Runner's working tree or breaks the Reviewer's clean-tree check. The agent **self-reports its own `transcript_path`** — Claude Code names a session's transcript directory after the slugified cwd, replacing **`/` and `.`** (and every other non-alphanumeric) with `-` — a naive `/`-only slug keeps dots and misses e.g. the `.herdr` segment in worktree paths like `~/.herdr/worktrees/…`, yielding an empty/wrong directory. Resolve it with `ls -t ~/.claude/projects/$(pwd | sed 's#[^A-Za-z0-9]#-#g')/*.jsonl | head -1` and take the newest `.jsonl` by mtime under that directory at the moment it writes the report. `pane read` / `agent read` are a human observability aid, **never** the data channel.
- **Orchestrator fallback for a bad self-report.** If a report's `transcript_path` is empty or missing, resolve it yourself: glob `~/.claude/projects/` for the dir whose name ends with the worktree/branch leaf and take the newest `*.jsonl` under it. Degrade gracefully — never fail the score step over a bad self-report.
- **Sentinel — human-readable cue only, NOT a machine gate.** Each agent's final terminal action prints `<<<AFK_WORK_DONE>>>` on success or `<<<AFK_WORK_BLOCKED>>>` on HITL. Live-verified this is **unsafe as a `wait output --match` target**: the prompt text you send the agent *contains this literal token* (it's part of the instruction telling the agent what to print), so it sits in the pane's scrollback the moment you send it — and `wait output` then matches the **prompt's own echo** instantly, firing a false DONE before the agent has done anything. Never gate on it; treat it as a label for a human glancing at the pane.

## Completion detection — report-file primary, `agent get` for blocked, one canonical monitor

- **Primary DONE gate: report-file existence.** Poll for `~/.afk-herdr/<N>/<role>-report.json` on disk. Immune to buffer echo, glyph differences, and clock skew — a plain filesystem check, not a terminal match. Once present, read `.verdict` from it.
- **BLOCKED gate: `herdr agent get <name>` status.** A blocked agent is paused waiting on input and **has not written its report yet**, so file-existence can't catch a block — status is the only signal for it. This is accepted despite `agent get`/`wait agent-status`'s known flakiness (see ADR-0004) — there is no better signal. `herdr wait agent-status` alone stays demoted to corroboration only, never the sole gate (it timed out in live testing even when the target state was reached).
- **`agent_status: idle` is ambiguous — never treat it as DONE.** Live-verified it fires at the workspace-trust dialog, between ordinary turns, *and* at done. Only report-file existence means done; `idle` alone means nothing about completion.
- **Ship this one canonical monitor**, run via a single backgrounded Bash call, instead of authoring a bespoke poll script per run:

```bash
# $NAME   = qualified agent name ($RUNNER_NAME/$REVIEWER_NAME, i.e. "runner-<tab_id>"/"reviewer-<tab_id>")
# $REPORT = ~/.afk-herdr/<N>/<role>-report.json for this agent
while true; do
  if [[ -f "$REPORT" ]]; then
    echo "done: report file present at $REPORT"
    break
  fi
  agent_status=$(herdr agent get "$NAME" | jq -r '.result.agent.agent_status // .agent.agent_status // empty')
  if [[ "$agent_status" == "blocked" ]]; then
    echo "blocked: $NAME is waiting on human input"
    # handle per HITL below, then keep looping — never abandon the pane agent;
    # a report file can still appear later once the human unblocks it in-pane
  fi
  sleep 5
done
```

- `done` (report file present) with a `.verdict` other than success, or a `blocked` status with **no report file ever appearing**, are both surfaced as-is — never fabricate a result. Sentinel text visible via `herdr pane read <pane-id>` is a cue you can mention to the human, nothing more.

## HITL / blocked handling

On the monitor loop (Completion detection, above) reporting `agent_status: blocked`:

1. `herdr tab focus <tab-id>` (surface the live pane agent to the human).
2. `herdr notification show "issue #N <role> blocked" --body "<reason from the pane>" --sound request`.
3. Report the reason to the human.
4. **Keep waiting** (the monitor loop keeps polling for the report file) — the human unblocks in-pane and the pipeline resumes; do not tear anything down or abandon the pane agent on a block. Use a generous timeout with a re-notify loop (exact cadence is a non-blocking open item — start conservative, e.g. re-notify every few minutes of continued `blocked`, and tune from experience) so you never wait forever silently.

## Pipeline

1. **Preflight** (above), including the workspace-trust repo-root check. Abort with a clear report if anything fails.
2. **Resolve launch flags, write both prompt files, then create the worktree** (Isolation, above): `herdr worktree create --cwd <target-repo> --branch afk/<N>-<slug> --base <base> --label "issue #N" --json`, then `herdr workspace rename <workspace-id> "afk/<repo>#<N>"`. Track the workspace id, tab id, worktree path, and root pane id.
3. **Start the Runner pane** (`$RUNNER_NAME`), labeled `runner`, `--cwd` the shared worktree, with the model + permission flags (Agent control); close the spare root pane **only on a successful start** (Hardening, above) — on a failed start, clean teardown and stop instead; run the trust check, readiness wait, send, submit, and verify-resend choreography (Agent control); this sends the Runner prompt (template below).
4. **Watch for completion** via the canonical monitor (report-file primary, `agent get` for blocked). Handle any `blocked` per HITL — keep waiting, don't skip ahead.
5. **On Runner done:** read `~/.afk-herdr/<N>/runner-report.json`; if missing, treat as failure and stop. Verify the PR it reports: `gh pr view <pr> --json baseRefName,headRefName` → base = `<base>`, head = the reported branch. If `transcript_path` is empty, apply the Orchestrator fallback (Data channel, above) before step 6.
6. **Score the Runner Trajectory:** bootstrap deps if needed (`[[ -d <plugin-root>/eval/node_modules ]] || ( cd <plugin-root>/eval && bun install )`), then `( cd <plugin-root>/eval && bun run scripts/eval-pr.ts --pr <pr> --repo <owner/repo> --transcript <runner transcript_path> --publish )` — run from `<plugin-root>/eval`, **not** the worktree (advisory Scorecard #1 — no `--fail-on-gate`, matching the existing advisory-first rollout).
7. **Start the Reviewer pane** (`$REVIEWER_NAME`), labeled `reviewer`, `--split right`, `--cwd` the **same** shared worktree (no `gh pr checkout`); run the same trust/readiness/send/submit/verify-resend choreography; this sends the Reviewer prompt (template below), which first asserts clean tree + `HEAD == origin PR head`.
8. **Watch for completion** the same way as step 4.
9. **On Reviewer done:** read `~/.afk-herdr/<N>/reviewer-report.json`; if missing, treat as failure and stop. If `transcript_path` is empty, apply the Orchestrator fallback (Data channel, above) before step 10.
10. **Score the full Trajectory:** same bootstrap guard as step 6, then `( cd <plugin-root>/eval && bun run scripts/eval-pr.ts --pr <pr> --repo <owner/repo> --transcript <runner transcript_path> --reviewer-transcript <reviewer transcript_path> --publish )` (Scorecard #2 — now carries the Reviewer's efficiency/security findings alongside the Runner's).
11. **Report** to the human: PR URL, Reviewer verdict (APPROVE / CHANGES MADE / BLOCKED-needs-human), final test result, both Scorecards' gate state, worktree path, tab id.
12. **Teardown Phase 1** (automatic — see below).

Default: **leave the PR open for a human merge**. Merge only on explicit request: `gh pr merge <n> --squash --delete-branch`.

## Deltas from the in-process prompt templates

Reuse `afk-issue`'s [`afk-task-runner` prompt template](../afk-issue/SKILL.md#afk-task-runner-prompt-template) and [`code-reviewer` prompt template](../afk-issue/SKILL.md#code-reviewer-prompt-template) verbatim as the base, **plus** these herdr-specific deltas — a naive pane-hosted port of either template silently breaks:

**Runner delta:**
- You are running **directly in the shared worktree** the Orchestrator already created (`--cwd`) — do NOT create or check out your own worktree; you are not isolated by the harness here.
- Before your final message, self-report your own transcript path — `ls -t ~/.claude/projects/$(pwd | sed 's#[^A-Za-z0-9]#-#g')/*.jsonl | head -1` (see Data channel, above; never the naive `/`-only slug) — and write `~/.afk-herdr/<N>/runner-report.json`: `{pr, branch, transcript_path, test_result, verdict}`.
- Your final terminal output must be exactly `<<<AFK_WORK_DONE>>>` on success or `<<<AFK_WORK_BLOCKED>>>` if you need a human (state the reason just before it).

**Reviewer delta:**
- **Skip `gh pr checkout`.** You are running in the Runner's own worktree, already on the PR's branch. Before reviewing, assert `git status --porcelain` is empty and `git rev-parse HEAD` equals `gh pr view <pr> --json headRefOid -q .headRefOid` — if either fails, stop and report (don't review a tree you can't trust).
- **Push your own commits.** The in-process `code-reviewer-push.sh` hook only fires on the `code-reviewer` `SubagentStop` event — it never fires for you, because you are a top-level pane process whose termination is a `Stop` in your own session, not a `SubagentStop` in the Orchestrator's. After committing `RALPH: Review - …`, run `git push` yourself.
- Same self-report + sentinel contract as the Runner: resolve your transcript path with the same robust command (`ls -t ~/.claude/projects/$(pwd | sed 's#[^A-Za-z0-9]#-#g')/*.jsonl | head -1`), write `~/.afk-herdr/<N>/reviewer-report.json`, and end with `<<<AFK_WORK_DONE>>>` / `<<<AFK_WORK_BLOCKED>>>`.

## Evaluation — orchestrator-driven, per role

The Evaluator (`eval/scripts/eval-pr.ts`) is a read-only CLI, not a spawnable agent. The existing `code-reviewer` `SubagentStop` → `run-evaluator.sh` wiring is **dead here** for the same reason the push hook is dead: pane-hosted agents are top-level processes, so that hook never fires in the Orchestrator. You therefore invoke `eval-pr.ts` yourself, explicitly, per role (pipeline steps 6 and 10) — always passing `--transcript`/`--reviewer-transcript` explicitly from the self-reported report files, never relying on manifest auto-resolution (which tags top-level `Stop` events `role=runner` by default and would mis-tag the Reviewer's own `Stop`). Top-level `Stop` → `capture-run.sh` still fires per-pane and harmlessly links PR→transcript in the manifest; it's inert here since you never read the manifest for control flow.

**Deps bootstrap — mirror the hook's guard, don't assume `node_modules` exists.** The plugin ships `eval/` source without `node_modules` installed. Calling `eval-pr.ts` directly (unlike the `run-evaluator.sh` hook path) bypasses that hook's existing dependency guard, so both eval invocations (pipeline steps 6 and 10) must mirror it themselves, matching `hooks/run-evaluator.sh:57-62`:

```bash
[[ -d "<plugin-root>/eval/node_modules" ]] || ( cd "<plugin-root>/eval" && bun install )
( cd "<plugin-root>/eval" && bun run scripts/eval-pr.ts --pr <pr> --repo <owner/repo> --transcript <runner transcript_path> [--reviewer-transcript <reviewer transcript_path>] --publish )
```

Run `eval-pr.ts` **from `<plugin-root>/eval`** (its `bun install`/dependency resolution is scoped there), never from the worktree.

## Teardown — auto Phase 1, explicit Phase 2

- **Phase 1 (automatic, end of pipeline):** deliver the report, publish both Scorecards, **leave the PR open** for human merge, **leave the workspace (tab + panes) and worktree in place** for inspection of the completed transcripts.
- **Phase 2 (explicit, only on the human's "done"/wrap-up):** a **single** command: `herdr worktree remove --workspace <workspace-id> --force`. Live-verified this one call removes the worktree **and** closes the workspace **and** reclaims its tabs + panes atomically (even with a pane's cwd still inside it) **and** prunes the git worktree — the branch is preserved on origin, so a human can still `git worktree add`/`gh pr checkout` it later. **Do not** split this into `workspace close` then `worktree remove --workspace <id>` — that ordering is circular: `worktree remove` is keyed by `--workspace <id>`, and that id no longer resolves once the workspace is already closed, forcing a raw-`git` fallback. Keep the raw-git fallback (`git worktree remove --force <path>` + `git worktree prune`) only for the now-unlikely case where the workspace id is already gone for some other reason.
- Safety rules (non-negotiable): the Orchestrator only ever closes the **workspace it created** (by tracked id); never blanket-close "non-focused" panes; never close a workspace or pane you did not create; never assume ownership of the human's focused pane.

## Sub-agent nesting (deliberately preserved, not yet exercised)

Because the Runner and Reviewer are full Claude Code sessions, either can itself use the `Task` tool to spawn its own sub-agents inside its pane — this "just works" as an ordinary in-process subagent call from within that pane agent's session, with its own `SubagentStop` firing locally. **This is why the permission policy keeps `Task` available** (it denies web + MCP but not `Task`): it's the seam for the planned **Engineer** role (`CONTEXT.md`; tracked in #63) — a specialized implementer the Runner/Reviewer will delegate risky slices to. This skill does not yet require or orchestrate that nesting; today's locked prompts never invoke it, so keeping `Task` available is latent, not active.

**Efficiency-parity caveat for whoever wires Engineer in:** the in-process agent defs (`agents/afk-task-runner.md`, `agents/code-reviewer.md`) grant `tools:` with **no `Task`**, so the in-process `afk-issue` Runner currently *cannot* nest. If pane agents start nesting but the in-process ones can't, the two variants' Trajectories diverge and the **Efficiency dimension** comparison between them breaks (the same reason `--model` is pinned). So add the Engineer capability to **both** variants together — grant `Task` in the agent defs and teach both prompts to use it — never to the pane path alone.

## Open items (non-blocking, decide during implementation)

- HITL keep-waiting timeout + re-notify cadence — start conservative and tune from experience; not fixed by this skill.

## When NOT to use this skill

- **No herdr session** (`HERDR_ENV` unset) → use `afk-issue` (in-process, no observability/intervention).
- **Multiple issues** → `feature-branch-fan-in` (or its herdr variant, once it exists — currently deferred).
- **Design not locked** → `grill-with-docs` first.
- **No issue yet** → `to-issues` first.
