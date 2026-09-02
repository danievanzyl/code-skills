# Markdown subagents

Pi extension that runs Markdown-defined personas in isolated child `pi` processes. Dispatch is non-blocking: the tool returns immediately, and each final report is delivered back to the parent context as a follow-up message.

## Persona locations

Default (`scope: "user"`):

- Bundled package personas in `extensions/subagents/agents/*.md`
- User overrides in `~/.pi/agent/agents/*.md`

Optional trusted-project scopes also load the nearest:

- `.pi/agents/*.md`

Later sources override an earlier persona with the same `name`: user personas override bundled personas, and project personas override both when using `scope: "both"`.

Bundled Pi personas:

- `codebase-analyzer` — traces local implementation and data flow with `file:line` evidence
- `gh-search-researcher` — researches GitHub through `gh`
- `web-search-researcher` — researches web sources

## Persona format

Persona files use YAML frontmatter:

```markdown
---
name: code-reviewer
description: Reviews changes for correctness and regressions
tools: read, ls, bash
model: sonnet
thinking: low
inheritSkills: false
---

You are a focused code reviewer. Use `rg` for content search and `fd` for file discovery through `bash`. Cite file and line references.
```

Use Pi-native tool names in `tools`. For shell-based searching, grant `bash` and instruct the persona to use `rg` and `fd`.

`thinking` accepts Pi's `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` levels. A valid persona value is passed through `--thinking`, including when the persona pins a `model`. Without `thinking`, a persona whose model is absent or `inherit` inherits the parent's model and thinking level; a model-pinned persona uses Pi's normal model thinking default. Invalid values are ignored.

`inheritSkills` accepts a boolean persona default. An explicit `subagent` tool-call value takes precedence, followed by the persona value, then the existing `true` default. Invalid non-boolean values are ignored.

## Usage

- `/subagents` lists user personas.
- `/subagents both` also lists project personas.
- The parent model calls `subagent` with `{ persona, task }`.
- `/subagent-cancel <job-id|all>` cancels background jobs.

Example request:

```text
Ask codebase-analyzer to trace the authentication flow and report file:line references.
```

## Isolation and skill inheritance

Each invocation uses `pi --mode json -p --no-session`, so it has a fresh conversation and no persisted child session. It runs in the parent's working directory, retaining normal project context and file access. The parent agent is free to continue working while the child runs; completion is injected with `deliverAs: "followUp"` and triggers a parent turn when idle.

In TUI mode, active jobs register a `subagents` section in the shared top-right status window. Each row shows the persona name, elapsed wall time, latest context size, and cumulative input/output tokens. The section updates every second and disappears automatically when no jobs are running. It shares one window with GitHub and future status plugins, avoiding overlapping overlays.

When effective `inheritSkills` is `true`, the extension captures the skills loaded in the current parent turn, disables child skill auto-discovery, and passes those exact skill paths with repeated `--skill` flags. Set it to `false` in a tool call or persona to avoid inheriting parent skills and let the child perform normal skill discovery instead.

The `subagent` tool is excluded in children to avoid recursive delegation. Pressing Ctrl+C aborts the child process. Reports returned to the parent are capped at 50 KB.
