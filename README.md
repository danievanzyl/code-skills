# Claude Code Config

Personal configuration for [Claude Code](https://claude.ai/claude-code) — Anthropic's CLI for Claude.

## Installing skills

Install skills from this repo with:

```sh
npx skills@latest add danievanzyl/code-skills
```

## Structure

| Path | Description |
|------|-------------|
| `CLAUDE.md` | Global instructions applied to all sessions |
| `agents/` | Custom sub-agent definitions (codebase-analyzer, codebase-locator, etc.) |
| `skills/` | Reusable skill definitions (gh-github, tf-style-guide, etc.) |
| `commands/` | Custom slash commands |
| `settings.json` | Claude Code settings |
| `hooks/` | Hook configurations |

## Agents

- **codebase-analyzer** — Analyzes implementation details with file:line references
- **codebase-locator** — Locates files and directories relevant to a feature
- **codebase-pattern-finder** — Finds similar implementations and usage patterns
- **gh-search-researcher** — Researches GitHub repos, PRs, issues via `gh` CLI
- **thoughts-analyzer** — Deep dives on research topics
- **thoughts-locator** — Discovers relevant documents in thoughts directories
- **web-search-researcher** — Researches topics via web search
- **swift-expect** — Swift development specialist

## Credits

Many of the skills and commands in this config are based on [HumanLayer's](https://github.com/humanlayer/humanlayer) workflow patterns.
