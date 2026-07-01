# code-skills — Agent Evaluation

Language for judging how the repo's autonomous (AFK) agents arrive at solutions:
what an agent did, whether the path was acceptable, whether it stayed safe, and
how much it cost. Exists to give visibility into agent behaviour first, gating
and skill-improvement later.

## Language

### Agent roles

**Runner**:
The autonomous agent that picks up an issue, implements it, and opens a PR for one unit of work.
_Avoid_: worker, afk-agent, bot

**Reviewer**:
The agent that reviews a Runner's PR and *mutates* it to make it mergeable — fixes issues, pushes commits. Judges and changes the artifact.
_Avoid_: grader, code-reviewer (that is the implementation name)

**Evaluator**:
The read-only agent that runs after the Reviewer and *scores* the Run without changing anything. Judges both agents' work and process; never fixes.
_Avoid_: scorer, auditor, observer

### Units & artifacts

**Run**:
One pass through the AFK loop for a single issue — the Runner's implementation plus the Reviewer's changes — culminating in one PR. The unit that gets evaluated.
_Avoid_: session, job, task

**Trajectory**:
The ordered record of what one agent actually did during a Run — its reasoning, tool calls, and results. Each Run has a Runner Trajectory and a Reviewer Trajectory. The basis for Process and Efficiency evaluation.
_Avoid_: transcript, log, history

**Scorecard**:
The Evaluator's structured output for one Run: per-role, per-dimension findings with an overall verdict. Read-only; advisory or gating depending on policy. Every finding is attributed to the role and, where identifiable, the skill or tool that produced it.
_Avoid_: report, grade, review

**Rubric**:
The named, versioned criteria the Evaluator scores against. Separate Runner and Reviewer rubrics, because the two agents do different jobs.
_Avoid_: rules, checklist, policy

### Evaluation dimensions

**Outcome dimension**:
Did the work succeed — does the diff solve the issue, do tests pass, is the PR mergeable. Scores the artifact.
_Avoid_: result, quality

**Process dimension**:
Did the agent take an acceptable path — right tools in a sensible order, no wasted or destructive calls, no re-designing a locked issue; for the Reviewer, genuinely inspecting rather than rubber-stamping. Scores the Trajectory.
_Avoid_: behaviour, trajectory-score

**Security dimension**:
Did the Run stay within bounds — no destructive commands, secret exposure, or non-allowlisted egress. Scores both Trajectory and diff. The same standard applies to both roles.
_Avoid_: safety, guardrails

**Efficiency dimension**:
How much a Run cost — tokens, tool-call steps, and wall-clock time. Interpreted comparatively against like work (same issue over time), never as an absolute score. The signal for whether an agent-prompt change made behaviour better or worse.
_Avoid_: cost, performance, speed
