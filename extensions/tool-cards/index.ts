import { ToolExecutionComponent, type ExtensionAPI, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { getCapabilities, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
const slot = Symbol("tool-card");
const empty: Component = { render: () => [], invalidate() {} };
const tint = (color: number, text: string) => `\x1b[${color}m${text}\x1b[0m`;

type Row = { context: RenderContext; content: ToolExecutionComponent; frame: Component };

export default function toolCards(pi: ExtensionAPI) {
	pi.registerToolRenderer((name, next) => {
		const native = next();
		if (native?.renderShell === "self") return native;
		const color = name === "bash" || name === "powershell" ? 33 : 35;
		const rowFor = (context: RenderContext): Row => {
			let row: Row = context.state[slot];
			if (row) {
				row.context = context;
				return row;
			}
			row = { context } as Row;
			// Pi owns native slot reuse, fallback previews and expansion. Only its shell is replaced.
			const renderers: ToolRenderers = {
				...native,
				renderShell: "self",
				renderCall: native?.renderCall && ((args, theme, inner) => native.renderCall!(args, theme, {
					...inner, executionStarted: row.context.executionStarted, argsComplete: row.context.argsComplete,
				})),
				renderResult: native?.renderResult && ((result, options, theme, inner) => native.renderResult!(result, options, theme, {
					...inner, showImages: row.context.showImages,
				})),
			};
			row.content = new ToolExecutionComponent(name, context.toolCallId, context.args, { showImages: false }, renderers,
				{ requestRender: () => row.context.invalidate() } as TUI, context.cwd);
			row.frame = {
				render(width) {
					if (width <= 0) return [];
					if (width < 6) return row.content.render(width).slice(1).map(line => truncateToWidth(line, width, ""));
					const inner = width - 4;
					const body = row.content.render(inner).slice(1);
					const status = row.context.isError ? "\x1b[41;97;1mFAILED\x1b[0m"
						: tint(color, row.context.isPartial ? "running" : "done");
					const label = truncateToWidth(` ${tint(color, name.toUpperCase())} / ${status} `, width - 4);
					return [
						tint(color, "╭─") + label + tint(color, "─".repeat(width - 4 - visibleWidth(label)) + "─╮"),
						...body.map(line => {
							const fitted = truncateToWidth(line, inner, "");
							return tint(color, "│") + " " + fitted + " ".repeat(inner - visibleWidth(fitted)) + " " + tint(color, "│");
						}),
						tint(color, "╰" + "─".repeat(width - 2) + "╯"),
					];
				},
				invalidate() { row.content.invalidate(); },
			};
			context.state[slot] = row;
			return row;
		};
		return {
			renderShell: "self",
			renderCall(args, _theme, context) {
				const row = rowFor(context);
				row.content.updateArgs(args);
				row.content.setExpanded(context.expanded);
				return row.frame;
			},
			renderResult(result, options, _theme, context) {
				const row = rowFor(context);
				// The outer Pi component owns inline images. Keep only their native text fallback when hidden or unsupported.
				const content = context.showImages && getCapabilities().images
					? result.content.filter(block => block.type !== "image") : result.content;
				row.content.updateResult({ ...result, content, isError: context.isError, durationMs: context.durationMs }, options.isPartial);
				return empty;
			},
		} satisfies ToolRenderers;
	});
}
