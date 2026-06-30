# code-skills

Skills, agents, and orchestration for autonomous (AFK) agents that pick up issues, implement them, and open PRs — plus the review and evaluation around that work.

## Language

### Agent roles

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
The ordered record of what an agent actually did during a Run — its reasoning steps, tool calls, and results. The basis for process evaluation.
_Avoid_: history, log, session transcript

**Scorecard**:
The Evaluator's structured output for one Run: per-dimension scores, findings, and an overall verdict. Read-only; advisory or gating depending on policy.
_Avoid_: report, grade, review

**Rubric**:
The named, versioned criteria the Evaluator scores a Trajectory and diff against (e.g. tool-call correctness, path adherence, security posture).
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
