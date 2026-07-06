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
| `plugin.json` | Plugin manifest (this repo is the `agentic-platform` plugin) |
| `.claude-plugin/` | `marketplace.json` — the single-marketplace definition everything installs from |
| `hooks/` | Hook configurations |
| `eval/` | **Run Evaluator** — read-only post-PR analyzer; scores a Run (Trajectory + diff) against a versioned Rubric, posts a security-gated check (see `eval/README.md` + `docs/adr/0001`) |
| `docs/adr/` | Architecture decision records |
| `scripts/` | Maintenance tooling (`sync-skills.sh`, `skill-sources.json`) |
| `.github/workflows/` | CI — `release.yml` (version bump on merge to main) + `sync-skills.yml` (weekly upstream-skill sync PR) + `tests.yml` (eval/ unit tests + hook regression tests) |
| `vendor/` | Attribution + provenance for vendored skills (generated) |
| `ralph/` | RALPH — autonomous AFK loop runner; drives Claude Code over an `issues/` queue until `<promise>NO MORE TASKS</promise>` (`afk.sh` loop / `once.sh` single pass + per-stack prompts) |
| `tmux-workflow/` | tmux + Ghostty session/worktree scripts (`sessionizer`, `new-branch`, `close-branch` with a PR-merged cleanup gate) |

## Agents

- **codebase-analyzer** — Analyzes implementation details with file:line references
- **codebase-locator** — Locates files and directories relevant to a feature
- **codebase-pattern-finder** — Finds similar implementations and usage patterns
- **gh-search-researcher** — Researches GitHub repos, PRs, issues via `gh` CLI
- **thoughts-analyzer** — Deep dives on research topics
- **thoughts-locator** — Discovers relevant documents in thoughts directories
- **web-search-researcher** — Researches topics via web search
- **swift-expect** — Swift development specialist

## Skills as a supply chain

This repo is the single source of truth for everything that runs in a session — first-party
agents, commands, hooks, and skills all live here. Trusted upstream skills aren't copy-pasted
in; they're **ingested via GitHub Actions** as recorded snapshots: each sync pins the exact
upstream commit and lands through a reviewed PR, so every dependency is versioned, attributed,
and auditable.

To keep everything under one marketplace, skills from external providers are vendored into
this plugin rather than installed as separate plugins. They land **flat** in `skills/<name>/`
so Claude Code's one-level skill auto-discovery registers them (a `plugin.json` `skills` array
is *not* honored from a root `plugin.json`, and nested dirs are too deep to be discovered), and
they invoke under this plugin's namespace, e.g. `agentic-platform:tdd`. Each vendored skill dir
carries a hidden `.vendored-from` marker recording its source.

- **Config**: `scripts/skill-sources.json` lists each provider (repo, the `ref` it tracks,
  categories to include, skills to exclude). Add a provider there — no code changes needed.
- **Sync**: `bash scripts/sync-skills.sh` mirrors the configured skills into `skills/<name>/`
  (writing a `.vendored-from` marker per skill) and the upstream `LICENSE` + provenance into
  `vendor/<provider>/`. Each run records the exact upstream commit SHA + date in
  `vendor/<provider>/manifest.json` and every `.vendored-from` marker — that recorded SHA **is**
  the pin and the audit trail (the configured `ref` may be a moving branch; what's committed
  here is always an exact snapshot). It's idempotent, and **prune is marker-scoped** — a re-sync only ever
  removes dirs carrying that provider's marker, never a hand-authored skill; name collisions
  with hand-authored skills are skipped. Vendored skill dirs are **generated — do not hand-edit.**
- **Automation**: `.github/workflows/sync-skills.yml` runs the sync weekly (and on demand via
  *Run workflow*), opening/updating a single `chore/sync-skills` PR. Merging it cuts a release.

Current providers:

- [`mattpocock/skills`](https://github.com/mattpocock/skills) (MIT)
- [`ogulcancelik/herdr`](https://github.com/ogulcancelik/herdr) (AGPL-3.0-or-later)

A vendored skill keeps its **own** upstream license (recorded in
`scripts/skill-sources.json`, `vendor/<provider>/`, and — shipped with the skill —
`skills/<name>/LICENSE`). This is distinct from the plugin's own MIT license in
`plugin.json`, which does not relicense vendored content. `herdr` is AGPL-3.0-or-later;
see [ADR 0003](docs/adr/0003-agpl-skill-in-mit-plugin.md).

## Credits

Many of the skills and commands in this config are based on [HumanLayer's](https://github.com/humanlayer/humanlayer) workflow patterns.
