import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	STATUS_INVALIDATE_EVENT,
	STATUS_REGISTER_EVENT,
	STATUS_REQUEST_EVENT,
	STATUS_UNREGISTER_EVENT,
	type StatusRow,
	type StatusSection,
} from "./api.ts";

const WINDOW_WIDTH = 48;
const MAX_CONTENT_LINES = 21;

class EmptyAnchor implements Component {
	render(): string[] { return []; }
	invalidate(): void {}
}

class StatusWindow implements Component {
	constructor(
		private readonly theme: Theme,
		private readonly getSections: () => StatusSection[],
	) {}

	private renderRow(row: StatusRow, innerWidth: number): string {
		const tone = row.tone ?? "text";
		const indent = " ".repeat(Math.max(0, row.indent ?? 0));
		const label = row.label ? `${this.theme.fg("dim", row.label.padEnd(9))} ` : "";
		const icon = row.icon ? `${this.theme.fg(tone, row.icon)} ` : "";
		return truncateToWidth(` ${indent}${label}${icon}${this.theme.fg(tone, row.text)}`, innerWidth, "…", true);
	}

	render(width: number): string[] {
		const w = Math.max(24, Math.min(width, WINDOW_WIDTH));
		const inner = w - 2;
		const border = (text: string) => this.theme.fg("border", text);
		const row = (content = "") => {
			const clipped = truncateToWidth(content, inner, "", true);
			return border("│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + border("│");
		};
		const divider = () => border("├") + border("─".repeat(inner)) + border("┤");
		const sections = this.getSections().filter((section) => section.visible?.() ?? true);
		const content: string[] = [];

		for (const section of sections) {
			let snapshot;
			try {
				snapshot = section.getSnapshot();
			} catch (error) {
				snapshot = {
					title: section.id,
					rows: [{ text: error instanceof Error ? error.message : String(error), tone: "error" as const }],
				};
			}
			if (content.length > 0) content.push(divider());
			const title = `${snapshot.icon ? `${snapshot.icon} ` : ""}${snapshot.title}`;
			content.push(row(` ${this.theme.fg("accent", this.theme.bold(title))}`));
			for (const statusRow of snapshot.rows) content.push(row(this.renderRow(statusRow, inner)));
			if (snapshot.footer) content.push(row(` ${this.theme.fg("dim", snapshot.footer)}`));
		}

		if (content.length === 0) return [];
		let omitted = 0;
		if (content.length > MAX_CONTENT_LINES) {
			omitted = content.length - (MAX_CONTENT_LINES - 1);
			content.splice(MAX_CONTENT_LINES - 1);
			content.push(row(` ${this.theme.fg("dim", `… ${omitted} more line${omitted === 1 ? "" : "s"}`)}`));
		}
		return [
			border("╭") + border("─".repeat(inner)) + border("╮"),
			...content,
			border("╰") + border("─".repeat(inner)) + border("╯"),
		];
	}

	invalidate(): void {}
}

export default function statusWindowExtension(pi: ExtensionAPI) {
	const sections = new Map<string, StatusSection>();
	let tui: TUI | undefined;
	let overlay: OverlayHandle | undefined;
	let panel: StatusWindow | undefined;
	let hiddenByUser = false;
	let disposed = false;

	const visibleSections = () => [...sections.values()]
		.filter((section) => section.visible?.() ?? true)
		.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));

	const update = () => {
		const shouldHide = hiddenByUser || visibleSections().length === 0;
		overlay?.setHidden(shouldHide);
		tui?.requestRender();
	};

	pi.events.on(STATUS_REGISTER_EVENT, (payload: unknown) => {
		const section = payload as StatusSection;
		if (!section?.id || typeof section.getSnapshot !== "function") return;
		sections.set(section.id, section);
		update();
	});
	pi.events.on(STATUS_UNREGISTER_EVENT, (payload: unknown) => {
		const id = (payload as { id?: string })?.id;
		if (id) sections.delete(id);
		update();
	});
	pi.events.on(STATUS_INVALIDATE_EVENT, () => update());

	pi.registerCommand("status-window", {
		description: "Control the shared plugin status window (show|hide|toggle|sections)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "toggle";
			if (action === "sections") {
				const list = [...sections.values()]
					.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
					.map((section) => `${section.id}${section.visible?.() === false ? " (inactive)" : ""}`)
					.join(", ");
				ctx.ui.notify(list || "No status sections registered", "info");
				return;
			}
			if (action === "show") hiddenByUser = false;
			else if (action === "hide") hiddenByUser = true;
			else if (action === "toggle") hiddenByUser = !hiddenByUser;
			else {
				ctx.ui.notify("Usage: /status-window show|hide|toggle|sections", "warning");
				return;
			}
			update();
		},
	});

	pi.on("session_start", (_event, ctx) => {
		disposed = false;
		sections.clear();
		ctx.ui.setWidget("status-window-anchor", (app, theme) => {
			tui = app;
			panel = new StatusWindow(theme, visibleSections);
			queueMicrotask(() => {
				if (disposed || overlay || !panel) return;
				overlay = app.showOverlay(panel, {
					nonCapturing: true,
					anchor: "top-right",
					width: WINDOW_WIDTH,
					maxHeight: 24,
					margin: { top: 1, right: 1 },
					visible: (terminalWidth) => terminalWidth >= 70,
				});
				update();
			});
			return new EmptyAnchor();
		});
		pi.events.emit(STATUS_REQUEST_EVENT, undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		disposed = true;
		overlay?.hide();
		overlay = undefined;
		panel = undefined;
		tui = undefined;
		sections.clear();
		ctx.ui.setWidget("status-window-anchor", undefined);
	});
}
