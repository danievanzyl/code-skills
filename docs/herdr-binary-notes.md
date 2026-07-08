# herdr binary notes

Binary capabilities absent from the vendored `skills/herdr/SKILL.md` as of
upstream `77f0339c3cd387c4ca3f4f240ff8b88065d66a22` / 2026-07-08. Run
`herdr <subcommand>` (no args) for authoritative, current help — this doc is
a dated, shrinking delta, not a parallel manual. **Delete each entry once
upstream documents it**; do not let this file grow into a second SKILL.md.

## `herdr notification show`

```
herdr notification show <title> [--body TEXT] [--position top-left|top-right|bottom-left|bottom-right] [--sound none|done|request]
```

## `herdr worktree` — pane-aware worktree lifecycle

```
herdr worktree list [--workspace ID | --cwd PATH] [--json]
herdr worktree create [--workspace ID | --cwd PATH] [--branch NAME] [--base REF] [--path PATH] [--label TEXT] [--focus] [--no-focus] [--json]
herdr worktree open [--workspace ID | --cwd PATH] (--path PATH | --branch NAME) [--label TEXT] [--focus] [--no-focus] [--json]
herdr worktree remove --workspace ID [--force] [--json]
```

## `herdr pane rename`

```
herdr pane rename <pane_id> <label>|--clear
```

## `herdr pane split` — undocumented flags

The vendored SKILL.md's "split a pane" section only shows `--direction` and
`--no-focus`. The binary also accepts:

```
herdr pane split [<pane_id>|--pane ID|--current] --direction right|down [--ratio FLOAT] [--cwd PATH] [--env KEY=VALUE] [--focus] [--no-focus]
```

## `herdr agent` — agent control API

```
herdr agent list
herdr agent get <target>
herdr agent read <target> [--source visible|recent|recent-unwrapped] [--lines N] [--format text|ansi] [--ansi]
herdr agent send <target> <text>
herdr agent rename <target> <name>|--clear
herdr agent focus <target>
herdr agent wait <target> --status <idle|working|blocked|unknown> [--timeout MS]
herdr agent attach <target> [--takeover]
herdr agent start <name> [--cwd PATH] [--workspace ID] [--tab ID] [--split right|down] [--env KEY=VALUE] [--focus|--no-focus] -- <argv...>
herdr agent explain <target> [--json]
herdr agent explain --file PATH --agent LABEL [--json]
```

`targets` accept terminal ids, unique agent names, detected/reported agent
labels, and legacy pane ids. `agent send` writes literal text; use `pane run`
for command text plus Enter.

Reporting and releasing an agent's status live under `pane`, not `agent`:

```
herdr pane report-agent <pane_id> --source ID --agent LABEL --state idle|working|blocked|unknown [--message TEXT] [--custom-status TEXT] [--seq N] [--agent-session-id ID] [--agent-session-path PATH]
herdr pane report-agent-session <pane_id> --source ID --agent LABEL [--seq N] [--agent-session-id ID] [--agent-session-path PATH]
herdr pane release-agent <pane_id> --source ID --agent LABEL [--seq N]
```

## other undocumented `pane` verbs

`herdr pane` also has `current`, `layout`, `process-info`, `neighbor`,
`edges`, `focus`, `resize`, `zoom`, `swap`, `move`, and `report-metadata` —
run `herdr pane` with no args for their exact syntax rather than
re-documenting each here.
