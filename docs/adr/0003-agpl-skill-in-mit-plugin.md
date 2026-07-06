---
status: accepted
closes: "#46"
---

# Vendoring an AGPL skill into an MIT-declared plugin

## Context

This plugin declares `"license": "MIT"` in `plugin.json`, and its first vendored
provider (`mattpocock/skills`) is MIT — so the blanket declaration was accurate.

The `herdr` skill (`ogulcancelik/herdr`, ref `master`, pinned at
`e98c49658caf054f2cfdc0f52831f29d59ed6fba`) is different: it is **dual-licensed
AGPL-3.0-or-later or commercial**. AGPL is strong copyleft — its terms cannot be
relicensed under MIT, and its license text must accompany the work wherever the
work is conveyed.

Two facts make this sharp:

- Users install a single skill via `npx skills add`, which copies the skill
  **directory** (`skills/herdr/`) — not the top-level repo, and not `vendor/`.
  If the AGPL license lived only in `vendor/ogulcancelik/`, an installer would
  receive AGPL content with no license attached.
- A reader who sees `plugin.json`'s `license: MIT` would reasonably assume every
  skill under this plugin is MIT. For `herdr`, that is false.

## Decision

Vendor `herdr` anyway, and make the license split explicit rather than implicit:

1. **The AGPL `LICENSE` ships inside `skills/herdr/`** (in addition to
   `vendor/ogulcancelik/`). This is what makes distribution AGPL-compliant: the
   license travels with the skill on `npx skills add`. The `skills[]` provider
   shape in `sync-skills.sh` (see #45) copies the upstream `LICENSE` into both
   the skill dir and `vendor/<provider>/`.

2. **`plugin.json`'s `license: MIT` describes the first-party plugin, not
   per-skill vendored content.** Vendored skills carry their own license, recorded
   in `scripts/skill-sources.json`, `vendor/<provider>/manifest.json`, and each
   skill's own `LICENSE`. The `README` states this explicitly.

3. **The mixed-license fact is documented, not hidden** — this ADR plus the
   README provider list, so a future reader is never surprised by AGPL content
   under an MIT-labelled plugin.

We deliberately did **not** change the `plugin.json` `license` field (e.g. to a
per-component expression) in this decision — that is a separate, unresolved
question. This ADR only records the vendoring decision and its compliance
mechanics.

## Consequences

- Anyone who redistributes the `herdr` skill (including via this marketplace) is
  subject to AGPL-3.0-or-later for that skill, and inherits the copyleft
  obligations — network-use disclosure among them. MIT continues to govern the
  first-party plugin and the MIT-licensed providers.
- The `plugin.json: MIT` declaration is now known to be **scope-limited**: it does
  not cover per-skill vendored content. Consumers must check a vendored skill's
  own `LICENSE` / its `vendor/<provider>/` entry.
- Future providers with copyleft or otherwise non-permissive licenses are handled
  the same way: license string in `skill-sources.json`, `LICENSE` shipped in the
  skill dir via the `skills[]` shape, and — if the obligation is materially new —
  a follow-up ADR.
- Open follow-up (out of scope here): whether to change the `plugin.json`
  `license` field itself so tooling that reads it isn't misled.
