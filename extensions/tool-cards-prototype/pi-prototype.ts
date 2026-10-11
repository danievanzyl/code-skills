// THROWAWAY: native Pi tool frames, not production. /card-variant A|B|C changes the same transcript.
import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

const tint = (color: number, text: string) => `\x1b[${color}m${text}\x1b[0m`;
const empty: Component = { render: () => [], invalidate() {} };
const slot = Symbol("throwaway-tool-card");
const names = { A: "Frame only", B: "Title and status badge", C: "Inline header" };
type Row = { call?: Component; result?: Component; partial: boolean; error: boolean; frame?: Component };

export default function (pi: ExtensionAPI) {
  let variant: keyof typeof names = "C";
  const redraw = new Map<string, () => void>();
  const frame = (row: Row, name: string): Component => ({
    render(width) {
      const children = [row.call, row.result].filter(Boolean) as Component[];
      if (width < 6) return children.flatMap(child => child.render(width));
      const color = row.error ? 31 : row.partial ? 90 : 36;
      const inner = width - 4;
      const line = (text: string) => {
        const fitted = truncateToWidth(text, inner);
        return tint(color, "│") + " " + fitted + " ".repeat(inner - visibleWidth(fitted)) + " " + tint(color, "│");
      };
      const status = row.error ? "FAILED" : row.partial ? "RUNNING" : "DONE";
      const title = name.toUpperCase();
      let top = tint(color, "╭" + "─".repeat(width - 2) + "╮");
      if (variant === "C") {
        const statusLabel = row.error ? "\x1b[41;97;1m FAILED \x1b[0m" : tint(row.partial ? 90 : 36, status.toLowerCase());
        const label = truncateToWidth(` ${tint(36, title)} / ${statusLabel} `, width - 4);
        top = tint(color, "╭─") + label + tint(color, "─".repeat(Math.max(0, width - 4 - visibleWidth(label))) + "─╮");
      }
      const body = children.flatMap(child => child.render(inner));
      if (variant === "B") {
        body.unshift(tint(36, title));
        body.push("", `\x1b[${color + 10};30;1m ${status} \x1b[0m`);
      }
      return [top, ...body.map(line), tint(color, "╰" + "─".repeat(width - 2) + "╯")];
    },
    invalidate() { row.call?.invalidate(); row.result?.invalidate(); },
  });

  pi.registerToolRenderer((name, next) => {
    const native = next();
    if (native?.renderShell === "self") return native;
    const rowFor = (context: any): Row => {
      redraw.set(context.toolCallId, context.invalidate);
      return context.state[slot] ??= { partial: context.isPartial, error: context.isError };
    };
    return {
      renderShell: "self",
      renderCall(args, theme, context) {
        const row = rowFor(context);
        row.partial = context.isPartial;
        row.error = context.isError;
        row.call = native?.renderCall
          ? native.renderCall(args, theme, { ...context, lastComponent: row.call })
          : new Text(theme.bold(name) + " " + JSON.stringify(args), 0, 0);
        return row.frame ??= frame(row, name);
      },
      renderResult(result, options, theme, context) {
        const row = rowFor(context);
        row.partial = options.isPartial;
        row.error = context.isError;
        row.result = native?.renderResult
          ? native.renderResult(result, options, theme, { ...context, lastComponent: row.result })
          : new Text(result.content.map(block => block.type === "text" ? block.text : "").join("\n"), 0, 0);
        return empty;
      },
    } satisfies ToolRenderers;
  });

  pi.registerMessageRenderer("prototype-reference", () => ({
    render(width) {
      const texts = [tint(36, "CREW MESSAGE"), tint(90, "message   ") + "20261011T095313Z-abec4acb", "\x1b[46;30;1m CREW MSG \x1b[0m " + tint(90, "shepard msg: 20261011T095313Z-abec4acb")];
      const inner = Math.max(0, width - 4);
      return [tint(36, "╭" + "─".repeat(Math.max(0, width - 2)) + "╮"), ...texts.map(text => {
        const fitted = truncateToWidth(text, inner);
        return tint(36, "│") + " " + fitted + " ".repeat(inner - visibleWidth(fitted)) + " " + tint(36, "│");
      }), tint(36, "╰" + "─".repeat(Math.max(0, width - 2)) + "╯")];
    },
    invalidate() {},
  }));

  const menu = (ctx: any) => ctx.ui.setWidget("prototype-layout", [
    `THROWAWAY / ${variant}: ${names[variant]} / real Pi rendering, replayed samples`,
    "/card-variant A|B|C   /   click a tool to expand its native output",
  ]);
  pi.on("session_start", (_event, ctx) => menu(ctx));
  pi.registerCommand("card-variant", {
    description: "Switch throwaway tool frames: A frame only, B title and badge, C inline header",
    handler: async (args, ctx) => {
      const selected = args.trim().toUpperCase() as keyof typeof names;
      if (!(selected in names)) { ctx.ui.notify("Use /card-variant A, B or C", "info"); return; }
      variant = selected;
      for (const invalidate of [...redraw.values()]) invalidate();
      menu(ctx);
    },
  });
}
