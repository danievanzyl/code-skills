---
status: accepted
---

# handoff-herdr: route a handoff to a waiting pane agent, matched by repo

## Context

The plain `handoff` skill produces a compacted **Handoff** document for a *fresh* Claude Code session to pick up later — it writes a file and stops; placing it is the human's problem. Inside a herdr session that last mile is mechanisable: a repo often already has a pane agent **waiting** (idle, or blocked on feedback / on starting a grill / on testing a spike) that is exactly the right place for the work to continue. `handoff-herdr` is the herdr-native sibling (naming per `afk-issue`→`afk-issue-herdr`, `feature-branch-fan-in`→`-herdr`) that adds **routing** on top of `handoff`'s document: produce → resolve a target → deliver.

Two facts shape it. **(1)** `herdr pane list` exposes per-pane `cwd`, `foreground_cwd`, and `agent_status` — enough to match a pane to a repo (git root of its `cwd`) and filter by wait state, so repo-keyed auto-routing is feasible with no new herdr surface. **(2)** This is **not** the AFK pipeline: targets are attended, human-owned continuation sessions, not scored **Runs**. There is no Efficiency-parity or Scorecard concern (that is `afk-issue-herdr`'s domain), which frees the launch policy from the AFK constraints.

## Decision

**Produce a Handoff, resolve a repo-matched *waiting* target, deliver a pointer to it — spawn a clean one when none waits. One spine serves both Offload and Dispatch intents.**

1. **Reuse, don't reimplement, `handoff`.** The document is produced by the existing `handoff` skill verbatim (deltas only), mirroring how `afk-issue-herdr` reuses `afk-issue`. Routing is the only new code.

2. **Degrade outside herdr.** Routing needs `HERDR_ENV=1`. If unset, the skill still produces the document and reports its path, then stops — the first half has standalone value, so a missing herdr session is a graceful degrade to plain `handoff`, not a hard error.

3. **Target resolution: match by repo of the routing session's cwd → waiting pane agent.** From `herdr pane list`, resolve each pane's git root from `cwd` and match it to the routing session's git root (worktrees of the same repo count as a match — match on git common dir). Keep candidates with `agent_status ∈ {idle, blocked}`. Exactly one → deliver; more than one → prompt the human to pick; zero → spawn (decision 5).

4. **Never auto-interrupt, never reuse stale context.** `working` agents are never auto-selected (interrupting a mid-flight agent corrupts its Trajectory and risks its worktree — the isolation the AFK design fought for). `done`/`unknown` agents are never auto-selected either — a finished agent carries a full transcript of unrelated work, and dropping a fresh Handoff on top blends contexts (the same anti-pattern that forces two panes in the AFK pipeline). Both remain reachable via an explicit `--target <name|pane-id>` override. An opt-in `--wait` flag holds the Handoff and polls the matched workspace until an agent frees, instead of spawning.

5. **Spawn a clean target when none waits.** No waiting match (matched-but-busy, or no matched workspace) → spawn: a new pane in the matched workspace if one exists, else a new workspace; `--cwd` = the routing session's current cwd (so an Offload continues in the exact same tree/branch); launch `claude --dangerously-skip-permissions --name $(basename $(pwd)) --model opus`; wait for readiness (with the defensive trust-dialog guard); then deliver.

6. **Deliver a pointer, not a paste.** `herdr agent send <name>` a short instruction pointing at the Handoff file path (+ `send-keys Enter` + verify-and-resend, the `afk-issue-herdr` choreography). The document already references artifacts by path, so the target has filesystem access by construction; a pointer keeps the pane input clean and dodges bracketed-paste size/echo fragility, and the target reads the doc with its own tools.

7. **Report and stop; never self-terminate silently.** The skill reports the target (workspace / tab / pane ids, agent name, Handoff path) and stops. A `--close` flag may close the *routing* session's own pane afterwards, but only with a printed confirmation — a skill silently killing the human's focused pane is the "never assume ownership of the human's focused pane" line the AFK teardown rules draw.

## Consequences

- **`--dangerously-skip-permissions` deliberately diverges from `afk-issue-herdr`, which bans it.** The AFK ban exists because a *scored Run* in a *shared worktree* must keep the guard hook and the destructive-command classifier intact. `handoff-herdr` targets are attended, human-owned continuation sessions in their own cwd with no eval contract — a different risk class — and the human wants zero permission friction on a session they are watching. Recorded here so a future reader does not "fix" the divergence by aligning the two.
- **No new herdr surface.** Routing rides entirely on existing `pane list` / `agent start` / `agent send` — nothing added to the vendored CLI. Stays **MIT** over the vendored **AGPL** `herdr`, same posture as ADR-0003/0004/0005/0006.
- **Offload vs Dispatch is intent, not code.** Both collapse to produce→resolve→deliver; the skill has no branch on which one the human meant, which keeps it a one-shot skill with no long-lived state (except the opt-in `--wait`).
- **`CONTEXT.md` gains three terms** — Handoff, Handoff target, Offload/Dispatch — because these are genuine domain vocabulary (the payload, the recipient's selection rule, the two intents), not mere workflow mechanics; contrast ADR-0005/0006, which added none.
- **The routing session's repo == the target repo, always** (match is keyed on its own cwd), so this never writes across repos — it only *spawns agents*, honouring the cross-repo write boundary.
