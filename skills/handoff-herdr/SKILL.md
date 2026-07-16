---
name: handoff-herdr
description: Herdr-native sibling of handoff — produces a Handoff document, then routes it to a repo-matched waiting pane agent (idle/blocked) instead of leaving placement to the human, spawning a clean target when none waits. Serves both Offload (my own context is too large, hand off and stop) and Dispatch (route a next task to an agent that's waiting on it) — same spine, no branch on intent. Use when the user says "handoff-herdr", "route this handoff", "hand this off to the other pane", "dispatch this to a waiting agent", or wants a Handoff delivered inside a herdr session rather than just written to disk. For outside herdr, or when only the document is wanted, use handoff directly.
argument-hint: "[what the next session is for] [--target <name|pane-id>] [--wait] [--close]"
disable-model-invocation: true
---

# handoff-herdr

Herdr-native sibling of `handoff`: produce a **Handoff** → resolve a **Handoff target** → deliver, adding routing on top of `handoff`'s document. **Orchestration glue, not a reimplementation** — the document is produced by the existing `handoff` skill verbatim (deltas only), the same way `afk-issue-herdr` reuses `afk-issue`. Design locked in issue #86 / [ADR-0007](../../docs/adr/0007-handoff-herdr-routing.md) — do not re-derive it. Use the `CONTEXT.md` "Handoff routing" glossary terms verbatim throughout (Handoff, Handoff target, Offload, Dispatch).

`$ARGUMENTS` = `[what the next session is for] --target <name|pane-id> --wait --close` (all flags optional; the positional text, if given, is passed straight through to `handoff`).

**Offload vs Dispatch is intent, not code** — both collapse to the same produce → resolve → deliver spine; this skill never branches on which one the human meant.

## Composition

- **Document = `handoff` verbatim.** Invoke it with `$ARGUMENTS`' positional text as its argument; it writes the Handoff to the OS temp dir and returns the path. Do not duplicate its content rules (redaction, "suggested skills", reference-by-path) here — see `skills/handoff/SKILL.md`.
- **Routing = this skill's only new behaviour.** Everything below (resolution, spawn, delivery, reporting) is additive on top of that document.

## Precondition — degrade outside herdr, don't error

Check `HERDR_ENV=1` (see `skills/herdr/SKILL.md`). If unset: produce the Handoff (Composition, above), report its path, and **stop** — no routing attempted, no error. A missing herdr session is a graceful degrade to plain `handoff`, not a failure; the document alone has standalone value. Everything past this point assumes `HERDR_ENV=1`.

If `herdr` help output doesn't match `skills/herdr/SKILL.md`, treat `docs/herdr-binary-notes.md` + live `herdr <subcommand>` output as current source of truth — in particular, live ids are the `wC:p1`/`wC:t1`/`wC` (workspace:tab:pane) shape, **not** the vendored doc's older `1-1`/`1:1`/`1` form. Don't hardcode either shape; parse whatever a live call returns.

## Argument surface

| Arg | Meaning |
| --- | --- |
| `[what the next session is for]` | Positional, like `handoff`; passed through to it verbatim. |
| `--target <name|pane-id>` | Explicit **Handoff target** override — skips matching and status filtering entirely (the only way to reach a `working`, `done`, or `unknown` agent). Resolve via `herdr agent get <target>`; if it doesn't resolve, stop and report. |
| `--wait` | Hold the Handoff and poll the matched workspace until a candidate frees, instead of spawning on zero matches. No effect combined with `--target`. If there is no matched workspace at all (see Resolution), there's nothing to poll — falls back to spawn immediately, same as without `--wait`. |
| `--close` | After delivery, close the routing session's own pane — only after printing a confirmation of what's being closed. |

## Resolution — repo match, then wait-state filter

Skip this whole section if `--target` was given (go straight to Delivery with that resolved agent).

1. **Routing session's git root:** `git rev-parse --path-format=absolute --git-common-dir` from the routing session's own cwd (its parent, if you want the checkout root — the common dir itself is what you compare against, so worktrees of the same repo naturally match).
2. **Candidates from `herdr pane list`** (see `docs/herdr-binary-notes.md` for the exact shape — no `--json` flag, plain stdout is already JSON): for each pane, resolve `git -C <pane.cwd> rev-parse --path-format=absolute --git-common-dir` and keep it only if that equals the routing session's git common dir. A pane whose `cwd` isn't inside any git repo fails this cleanly (non-zero exit) — drop it.
3. **Matched workspace** = the `workspace_id` shared by any pane that passed step 2, regardless of status — you need this for spawn placement (step 5) even when no candidate is currently waiting.
4. **Waiting candidates** = matched panes with `agent_status ∈ {idle, blocked}`. `working` is never auto-selected (mid-flight interruption corrupts its Trajectory-equivalent context); `done`/`unknown` is never auto-selected (stale context) — both reachable only via `--target`.
5. **Branch on count:**
   - **Zero** → **spawn** (below), unless `--wait` was given, in which case hold and poll the matched workspace (from step 3) — re-run steps 2–4 on an interval, deliver to the first candidate that turns idle/blocked. If step 3 found no matched workspace at all, `--wait` has nothing to poll — spawn immediately instead (Argument surface, above).
   - **Exactly one** → that's the Handoff target; go to Delivery.
   - **More than one** → prompt the human to pick, listing each candidate's agent name (if reported), workspace/tab/pane ids, `cwd`, and `agent_status`. Deliver to whichever they choose.

## Spawn — zero waiting candidates, no `--wait`

Spawn a clean target rather than reuse a busy or stale one:

- **Matched workspace exists** (step 3 above found one, just nothing currently waiting in it): add a new pane there — `herdr agent start <name> --workspace <matched-workspace-id> --tab <tab-id-of-a-matched-pane> --split right --cwd <routing-session-cwd> -- claude --dangerously-skip-permissions --name $(basename $(pwd)) --model opus`.
- **No matched workspace** (nothing in `herdr pane list` shares the repo at all): create one — `herdr workspace create --cwd <routing-session-cwd> --label <repo-name>`, parse `result.workspace.workspace_id` / `result.tab.tab_id` / `result.root_pane.pane_id`, then `herdr agent start <name> --workspace <new-workspace-id> --tab <new-tab-id> --cwd <routing-session-cwd> -- claude --dangerously-skip-permissions --name $(basename $(pwd)) --model opus`. `agent start` always creates its own new pane regardless of `--split` (per `docs/herdr-binary-notes.md`), so this leaves the fresh root pane spare — close it (`herdr pane close <root-pane-id>`) **only after** `agent start` returns a parseable `result.agent.pane_id`; on a failed start, leave the root pane alone and report the failure instead of proceeding.
- **`--cwd` = the routing session's own current cwd**, always — an Offload continues in the exact same tree/branch; a Dispatch starts a fresh agent looking at the same repo the human is routing from.
- **`--dangerously-skip-permissions` is deliberate here**, diverging from `afk-issue-herdr`'s ban on it: the target is an attended, human-owned continuation session in its own cwd, not a scored Run in a shared worktree — see ADR-0007 Consequences. Do not "fix" this to match `afk-issue-herdr`.
- **Readiness + trust guard:** reuse `afk-issue-herdr`'s choreography verbatim — after `agent start`, check `herdr pane read <pane-id>` for the trust-folder prompt and `send-keys Enter` past it if present, then `herdr agent wait <name> --status idle --timeout 30000` before delivering.

## Delivery — pointer, not paste

Reuse `afk-issue-herdr`'s send choreography verbatim, whether the target was matched, spawned, or `--target`-resolved:

1. `herdr agent send <name-or-pane-id> "<short instruction pointing at the Handoff file path>"` — a pointer (e.g. "Handoff waiting for you at /tmp/handoff-....md — read it and continue from there."), never the document body; the document already references its own artifacts by path, so the target reads it with its own tools.
2. `herdr pane send-keys <pane-id> Enter`.
3. **Verify-and-resend:** `herdr pane read <pane-id>` the input area; if the pointer text is still sitting unsent, re-send `send-keys Enter` (a few bounded retries, short pause between).

## Report and stop

Report, then stop — never self-terminate silently:

- The Handoff's file path.
- The resolved Handoff target: workspace id, tab id, pane id, agent name (if any).
- Which path was taken (matched-existing / spawned / `--target` override / `--wait` held-then-delivered).

**`--close`:** only now, after delivery is confirmed — print a confirmation naming the routing session's own pane id being closed, then `herdr pane close <own-pane-id>` (resolve it via `herdr pane current --current`). Never close any other pane. A skill silently killing the human's focused pane is exactly the "never assume ownership of the human's focused pane" line the AFK teardown rules draw — `--close` only ever targets the pane this skill itself is running in.

## When NOT to use this skill

- **No herdr session** (`HERDR_ENV` unset) → this skill already degrades to plain `handoff`'s behaviour; just use `handoff` directly if you know that's the case.
- **Only the document is wanted, no delivery** → use `handoff` directly.
- **Target is a scored AFK Run** (Runner/Reviewer pane) → that's `afk-issue-herdr`'s domain, not this skill's; don't route a Handoff into a pane mid-Run.
