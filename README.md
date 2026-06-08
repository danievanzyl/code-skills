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
| `skills/` | Reusable skill definitions — hand-authored + vendored (see below) |
| `commands/` | Custom slash commands |
| `settings.json` | Claude Code settings |
| `hooks/` | Hook configurations |
| `scripts/` | Maintenance tooling (`sync-skills.sh`, `skill-sources.json`) |
| `vendor/` | Attribution + provenance for vendored skills (generated) |

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
this plugin rather than installed as separate plugins. They land **flat** in `skills/<name>/`
so Claude Code's one-level skill auto-discovery registers them (a `plugin.json` `skills` array
is *not* honored from a root `plugin.json`, and nested dirs are too deep to be discovered), and
they invoke under this plugin's namespace, e.g. `agentic-platform:tdd`. Each vendored skill dir
carries a hidden `.vendored-from` marker recording its source.

- **Config**: `scripts/skill-sources.json` lists each provider (repo, ref, categories to
  include, skills to exclude). Add a provider there — no code changes needed.
- **Sync**: `bash scripts/sync-skills.sh` mirrors the configured skills into `skills/<name>/`
  (writing a `.vendored-from` marker per skill) and the upstream `LICENSE` + provenance into
  `vendor/<provider>/`. It's idempotent, and **prune is marker-scoped** — a re-sync only ever
  removes dirs carrying that provider's marker, never a hand-authored skill; name collisions
  with hand-authored skills are skipped. Vendored skill dirs are **generated — do not hand-edit.**
- **Automation**: `.github/workflows/sync-skills.yml` runs the sync weekly (and on demand via
  *Run workflow*), opening/updating a single `chore/sync-skills` PR. Merging it cuts a release.

Current provider: [`mattpocock/skills`](https://github.com/mattpocock/skills) (MIT).

## Credits

Many of the skills and commands in this config are based on [HumanLayer's](https://github.com/humanlayer/humanlayer) workflow patterns.
