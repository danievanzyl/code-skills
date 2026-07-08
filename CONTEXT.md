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
