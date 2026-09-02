# Markdown subagents

Pi extension that runs Markdown-defined personas in isolated child `pi` processes. Dispatch is non-blocking: the tool returns immediately, and each final report is delivered back to the parent context as a follow-up message.

## Persona locations

Default (`scope: "user"`):

- Bundled package personas in `extensions/subagents/agents/*.md`
- User overrides in `~/.pi/agent/agents/*.md`

Optional trusted-project scopes also load the nearest:

- `.pi/agents/*.md`

Later sources override an earlier persona with the same `name`: user personas override bundled personas, and project personas override both when using `scope: "both"`.

## Persona format

Persona files use YAML frontmatter:

```markdown
---
name: code-reviewer
description: Reviews changes for correctness and regressions
tools: read, ls, bash
model: sonnet
---

You are a focused code reviewer. Use `rg` for content search and `fd` for file discovery through `bash`. Cite file and line references.
```

Use Pi-native tool names in `tools`. For shell-based searching, grant `bash` and instruct the persona to use `rg` and `fd`. If `model` is absent or `inherit`, the child inherits the parent's model and thinking level.

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

`inheritSkills` defaults to `true`. The extension captures the skills loaded in the current parent turn, disables child skill auto-discovery, and passes those exact skill paths with repeated `--skill` flags. Set `inheritSkills: false` to let the child perform normal skill discovery instead.

The `subagent` tool is excluded in children to avoid recursive delegation. Pressing Ctrl+C aborts the child process. Reports returned to the parent are capped at 50 KB.
