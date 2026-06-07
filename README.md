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
| `skills/vendor/` | Skills vendored from external providers — generated, see below |
| `commands/` | Custom slash commands |
| `settings.json` | Claude Code settings |
| `hooks/` | Hook configurations |
| `scripts/` | Maintenance tooling (`sync-skills.sh`, `skill-sources.json`) |

## Agents

- **codebase-analyzer** — Analyzes implementation details with file:line references
- **codebase-locator** — Locates files and directories relevant to a feature
- **codebase-pattern-finder** — Finds similar implementations and usage patterns
- **gh-search-researcher** — Researches GitHub repos, PRs, issues via `gh` CLI
- **thoughts-analyzer** — Deep dives on research topics
- **thoughts-locator** — Discovers relevant documents in thoughts directories
- **web-search-researcher** — Researches topics via web search
- **swift-expect** — Swift development specialist

## Vendored skills

To keep everything under one marketplace, skills from external providers are vendored into
`skills/vendor/<provider>/` rather than installed as separate plugins. They register via the
`skills` array in `plugin.json` (which *extends* the default `skills/` scan — hand-authored
skills are unaffected) and invoke under this plugin's namespace, e.g. `agentic-platform:tdd`.

- **Config**: `scripts/skill-sources.json` lists each provider (repo, ref, categories to
  include, skills to exclude). Add a provider there — no code changes needed.
- **Sync**: `bash scripts/sync-skills.sh` mirrors the configured skills into `skills/vendor/**`,
  regenerates `plugin.json`'s `skills` array, and writes provenance + the upstream `LICENSE`
  into each provider dir. It's idempotent and skips any skill whose name collides with a
  hand-authored one. `skills/vendor/**` is **generated — do not hand-edit.**
- **Automation**: `.github/workflows/sync-skills.yml` runs the sync weekly (and on demand via
  *Run workflow*), opening/updating a single `chore/sync-skills` PR. Merging it cuts a release.

Current provider: [`mattpocock/skills`](https://github.com/mattpocock/skills) (MIT).

## Credits

Many of the skills and commands in this config are based on [HumanLayer's](https://github.com/humanlayer/humanlayer) workflow patterns.
