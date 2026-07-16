# code-skills

Skills, agents, and orchestration for autonomous (AFK) agents that pick up issues, implement them, and open PRs — plus the review and evaluation around that work.

## Language

### Agent roles

**Orchestrator**:
The agent that drives a pipeline of other agents for one or more issues — selects the work, spawns the Runner and Reviewer, holds their reported results (PR#, branch, worktree, transcript path), triggers the Evaluator, and owns teardown. Never implements or reviews itself; it is the hub the other roles report back to. Lives in the human's session (in-process subagents in `afk-issue`/`feature-branch-fan-in`; herdr-pane-hosted agents in the herdr variant).
_Avoid_: driver, coordinator, manager

**Runner**:
The autonomous agent that selects an issue, implements it, and opens a PR for one unit of work.
_Avoid_: afk-agent, worker, bot

**Reviewer**:
The agent that reviews a Runner's PR and *mutates* it to make it mergeable (fixes issues, pushes commits). Judges the artifact.
_Avoid_: code-reviewer (that is the implementation name), grader

**Evaluator**:
The read-only agent that runs as the final stage and *scores* a Run without changing it. Judges the work and the process, never fixes. Distinct from the Reviewer.
_Avoid_: scorer, auditor, observer

**Engineer** _(planned — not yet built)_:
A specialized implementer sub-agent a Runner (or Reviewer) delegates a focused slice of work to — e.g. a language- or domain-expert that owns a risky edit. Spawned in-process via the pane agent's own `Task` tool, so it has its own Trajectory nested under the Run. Not part of the current locked pipeline — it is the reason pane agents keep `Task` available (see `afk-issue-herdr`; tracked in #63). When built, wire it into **both** the in-process and herdr variants so the Efficiency dimension stays comparable.
_Avoid_: worker, specialist, helper

### Units & artifacts

**Run**:
One Runner execution that produces a single PR. The unit that gets evaluated.
_Avoid_: session (overloaded), job, task

**Trajectory**:
The ordered record of what one agent actually did during a Run — its reasoning steps, tool calls, and results. Each Run has a Runner Trajectory and a Reviewer Trajectory. The basis for Process and Efficiency evaluation.
_Avoid_: history, log, session transcript

**Scorecard**:
The Evaluator's structured output for one Run: per-role, per-dimension scores, findings, and an overall verdict. Every finding is attributed to the role and, where identifiable, the skill or tool that produced it. Read-only; advisory or gating depending on policy.
_Avoid_: report, grade, review

**Rubric**:
The named, versioned criteria the Evaluator scores a Trajectory and diff against (e.g. tool-call correctness, path adherence, security posture). Separate Runner and Reviewer rubrics, because the two agents do different jobs.
_Avoid_: rules (too vague), checklist, policy

### Evaluation dimensions

**Outcome dimension**:
Did the work succeed — does the diff do the right thing, with tests passing. Scores the artifact.
_Avoid_: result, quality

**Process dimension**:
Did the Runner take an acceptable path — right tools, right order, no unnecessary or destructive calls. Scores the Trajectory.
_Avoid_: behaviour, trajectory score

**Security dimension**:
Did the Run stay within security bounds — no excessive agency, secret exposure, or unsafe tool use. Scores both diff and Trajectory.
_Avoid_: safety, guardrails

**Efficiency dimension**:
How much a Run cost — tokens, tool-call steps, and wall-clock time. Interpreted comparatively against like work (same issue over time), never as an absolute score. The signal for whether an agent-prompt change made behaviour better or worse.
_Avoid_: cost, performance, speed

### Herdr structure

Terms owned by the `herdr` CLI (see `skills/herdr/SKILL.md`); use them **verbatim** — do not coin synonyms like "space". Hierarchy: session → workspace → tab → pane.

**Session** (herdr):
A persistent herdr multiplexer session (`herdr --session <name>`). The AFK skills only *detect* it (`HERDR_ENV=1`); they never create or manage one. Not the same thing as a Claude Code session — see Pane agent.
_Avoid_: bare "session" for anything running inside herdr

**Workspace**:
A herdr project/repo context; holds one or more tabs. An AFK run gets its **own dedicated workspace** the Orchestrator creates and owns, so teardown closes it wholesale without touching the human's panes.
_Avoid_: space, project

**Tab**:
A subcontext inside a workspace; holds one or more panes. One tab per issue (`issue #N`).
_Avoid_: window

**Pane**:
One terminal inside a tab. One pane per role — `runner` / `reviewer`.
_Avoid_: split, terminal

**Pane agent**:
The Claude Code session running inside a pane — a Runner or Reviewer as a full, top-level `claude` process (not an in-process subagent). One pane agent = one Trajectory = one Run participant. When naming the process rather than the role, say "pane agent" or "Claude Code session", **never** bare "session".
_Avoid_: session, pane session, terminal agent

### Handoff routing

Terms owned by the `handoff-herdr` skill (see [ADR-0007](docs/adr/0007-handoff-herdr-routing.md)); the herdr-native sibling of the plain `handoff` skill.

**Handoff**:
The compacted document the `handoff` skill produces so a *different* Claude Code session can pick up the work — references artifacts by path/URL, never duplicates them. `handoff-herdr` reuses it verbatim as the payload; the routing is a separate act layered on top. Not the routing itself.
_Avoid_: summary, context dump, transfer doc

**Handoff target**:
The pane agent a Handoff is routed to. Auto-selected only when it is a **waiting** agent (`agent_status ∈ {idle, blocked}`) in a herdr workspace whose repo matches the routing session's cwd. A `working` agent is never auto-interrupted; a `done`/`unknown` agent is never auto-selected (its context is stale) — both reachable only by explicit target. When no waiting target matches, one is **spawned** (fresh pane/workspace, clean context) rather than an existing agent reused.
_Avoid_: recipient, destination pane, receiver

**Offload / Dispatch**:
The two intents that both drive `handoff-herdr` down one spine (produce → resolve → deliver). **Offload** = the routing session's own context is too large, so it hands off to continue elsewhere and stop. **Dispatch** = routing a next task (a grill, feedback, a spike/prototype test) to an agent that is *waiting* on exactly that. Same mechanism, different reason — not two code paths.
_Avoid_: push/pull, delegate (reserved for Orchestrator→role spawning)
