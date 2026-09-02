import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface GitState {
	branch?: string;
	changed: number;
	untracked: number;
}

class EmptyFooter implements Component {
	render(): string[] { return []; }
	invalidate(): void {}
}

type MutableStack = {
	entries?: Array<{ component?: MutableStack; minSize?: number }>;
};

function collapseFullscreenFooter(app: TUI): void {
	if (app.mode !== "fullscreen") return;
	// Pi currently gives the fullscreen footer a hard-coded minSize of 1.
	// Feature-detect the internal stack and let our intentionally empty footer
	// measure to zero. If Pi's layout changes, this safely becomes a no-op.
	const root = (app as TUI & { layoutRoot?: MutableStack }).layoutRoot;
	const dock = root?.entries?.[1]?.component;
	const footerEntry = dock?.entries?.at(-1);
	if (footerEntry) footerEntry.minSize = 0;
}

function formatContext(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
	const percent = usage?.percent;

	if (!contextWindow || percent === null || percent === undefined) return "ctx ?";
	const windowLabel =
		contextWindow >= 1_000_000
			? `${(contextWindow / 1_000_000).toFixed(1)}M`
			: `${Math.round(contextWindow / 1000)}k`;
	return `${percent.toFixed(1)}%/${windowLabel}`;
}

function formatPath(cwd: string): string {
	const home = process.env.HOME;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function getHerdrPaneId(): string | undefined {
	const paneId = process.env.HERDR_PANE_ID?.trim();
	return process.env.HERDR_ENV === "1" && paneId ? paneId : undefined;
}

function fitBorderLine(
	status: string,
	width: number,
	colorBorder: (text: string) => string,
	leftCorner: string,
	rightCorner: string,
): string {
	if (width <= 0) return "";
	if (width === 1) return colorBorder("─");

	const cornersWidth = 2;
	const available = Math.max(0, width - cornersWidth);
	const fittedStatus = truncateToWidth(status, available, "");
	const fillWidth = Math.max(0, available - visibleWidth(fittedStatus));

	return colorBorder(leftCorner) + fittedStatus + colorBorder("─".repeat(fillWidth)) + colorBorder(rightCorner);
}

function fitAnimatedBottomBorder(
	status: string,
	width: number,
	colorBorder: (text: string) => string,
	colorProgress: (text: string) => string,
	working: boolean,
	tick: number,
): string {
	if (width <= 0) return "";
	if (width === 1) return colorBorder("─");

	const available = Math.max(0, width - 2);
	const fittedStatus = truncateToWidth(status, available, "");
	const fillWidth = Math.max(0, available - visibleWidth(fittedStatus));

	if (!working || fillWidth < 2) {
		return colorBorder("╰") + fittedStatus + colorBorder("─".repeat(fillWidth)) + colorBorder("╯");
	}

	const progressWidth = Math.min(3, fillWidth);
	const maxPosition = Math.max(0, fillWidth - progressWidth);
	const cycle = Math.max(1, maxPosition * 2);
	const phase = tick % cycle;
	const position = phase <= maxPosition ? phase : cycle - phase;
	const before = "─".repeat(position);
	const progress = "━".repeat(progressWidth);
	const after = "─".repeat(fillWidth - position - progressWidth);

	return colorBorder("╰") + fittedStatus + colorBorder(before) + colorProgress(progress) + colorBorder(after) + colorBorder("╯");
}

export default function (pi: ExtensionAPI) {
	let tui: TUI | undefined;
	let working = false;
	let animationTick = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let git: GitState = { changed: 0, untracked: 0 };
	let gitRefresh: Promise<void> | undefined;

	const stopSpinner = () => {
		if (spinnerTimer) clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	};

	const refreshGit = (ctx: ExtensionContext) => {
		if (gitRefresh) return gitRefresh;

		gitRefresh = (async () => {
			const result = await pi
				.exec("git", ["status", "--porcelain=v1", "--branch"], {
					cwd: ctx.cwd,
					timeout: 2000,
				})
				.catch(() => undefined);

			if (!result || result.code !== 0) {
				git = { changed: 0, untracked: 0 };
				return;
			}

			const lines = result.stdout.split("\n").filter(Boolean);
			const header = lines.shift();
			let branch = header?.replace(/^##\s+/, "").split("...")[0]?.trim();
			branch = branch?.replace(/^No commits yet on\s+/, "");

			let changed = 0;
			let untracked = 0;
			for (const line of lines) {
				if (line.startsWith("??")) untracked++;
				else changed++;
			}

			git = { branch: branch || undefined, changed, untracked };
		})().finally(() => {
			gitRefresh = undefined;
			tui?.requestRender();
		});

		return gitRefresh;
	};

	pi.on("agent_start", (_event, ctx) => {
		working = true;
		stopSpinner();
		animationTick = 0;
		spinnerTimer = setInterval(() => {
			animationTick++;
			tui?.requestRender();
		}, 55);
		void refreshGit(ctx);
		tui?.requestRender();
	});

	pi.on("agent_settled", (_event, ctx) => {
		working = false;
		stopSpinner();
		void refreshGit(ctx);
		tui?.requestRender();
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		void refreshGit(ctx);
	});

	pi.on("model_select", () => tui?.requestRender());
	pi.on("thinking_level_select", () => tui?.requestRender());

	pi.on("session_shutdown", () => {
		stopSpinner();
		tui = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setFooter(() => new EmptyFooter());
		void refreshGit(ctx);

		class PictureStatusEditor extends CustomEditor {
			private readonly defaultBorderColor: (text: string) => string;

			constructor(app: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(app, theme, keybindings, { paddingX: 0 });
				this.defaultBorderColor = this.borderColor;
				tui = app;
				collapseFullscreenFooter(app);
				app.requestRender();
			}

			render(width: number): string[] {
				const theme = ctx.ui.theme;
				const contextPercent = ctx.getContextUsage()?.percent ?? 0;
				this.borderColor =
					contextPercent >= 20
						? (text) => theme.fg("error", text)
						: contextPercent > 12
							? (text) => theme.fg("warning", text)
							: this.defaultBorderColor;

				const lines = super.render(width);
				if (lines.length === 0) return lines;

				const separator = theme.fg("dim", " › ");
				const model = ctx.model?.id ?? "no-model";
				const thinking = pi.getThinkingLevel();

				const parts = [
					theme.fg("warning", theme.bold("π")),
					theme.fg("accent", ` ${model}`),
					theme.fg("warning", `󰧑 ${thinking}`),
				];

				if (git.branch) {
					let gitText = ` ${git.branch}`;
					if (git.changed > 0) gitText += ` *${git.changed}`;
					if (git.untracked > 0) gitText += ` ?${git.untracked}`;
					parts.push(theme.fg("warning", gitText));
				}

				parts.push(theme.fg("muted", `◧ ${formatContext(ctx)}`));

				const borderColor = (text: string) => this.borderColor(text);
				const topStatus = borderColor("─") + parts.join(separator) + borderColor("─");
				const paneId = getHerdrPaneId();
				const location = paneId
					? theme.fg("thinkingHigh", ` ${paneId} `) + theme.fg("accent", `${formatPath(ctx.cwd)} `)
					: theme.fg("accent", ` ${formatPath(ctx.cwd)} `);
				const pathStatus = borderColor("─") + location + borderColor("─");

				lines[0] = fitBorderLine(topStatus, width, borderColor, "╭", "╮");
				if (lines.length > 1) {
					lines[lines.length - 1] = fitAnimatedBottomBorder(
						pathStatus,
						width,
						borderColor,
						(text) => theme.fg("accent", text),
						working,
						animationTick,
					);
				}
				return lines;
			}
		}

		ctx.ui.setEditorComponent((app, theme, keybindings) => new PictureStatusEditor(app, theme, keybindings));
	});
}
