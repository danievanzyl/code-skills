# Shared status window

A single non-capturing top-right window that composes status sections from independent Pi extensions. This prevents plugins from creating overlapping overlays.

## Behavior

- Width: 48 columns
- Maximum height: 24 rows
- Hidden on terminals narrower than 70 columns
- Sections are stacked by descending `priority`
- Empty/inactive sections are omitted
- Overflow is truncated with an omitted-line count

Commands:

```text
/status-window show
/status-window hide
/status-window toggle
/status-window sections
```

## Registering a section

Import the shared API and publish a data-oriented section. Registration is idempotent by `id`.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  STATUS_REQUEST_EVENT,
  invalidateStatusSection,
  publishStatusSection,
  removeStatusSection,
  type StatusSection,
} from "./status-window/api.ts";

export default function (pi: ExtensionAPI) {
  let value = "waiting";

  const section: StatusSection = {
    id: "example",
    priority: 10,
    visible: () => true,
    getSnapshot: () => ({
      title: "Example",
      icon: "●",
      rows: [
        { label: "State", text: value, tone: "success" },
      ],
      footer: "/example refresh",
    }),
  };

  const publish = () => publishStatusSection(pi, section);
  pi.events.on(STATUS_REQUEST_EVENT, publish);

  pi.on("session_start", publish);
  pi.on("session_shutdown", () => removeStatusSection(pi, section.id));

  // Call after changing data or visibility.
  const update = (next: string) => {
    value = next;
    invalidateStatusSection(pi, section.id);
  };
}
```

## Row schema

```ts
type StatusRow = {
  label?: string;
  text: string;
  tone?: "text" | "accent" | "muted" | "dim" | "success" | "warning" | "error";
  icon?: string;
  indent?: number;
};
```

Plugins provide plain data rather than arbitrary components, allowing the host to enforce sizing, borders, theme colors, ordering, and responsive behavior consistently.
