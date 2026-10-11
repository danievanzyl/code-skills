import { expect, test } from "bun:test";
import {
	createBashToolDefinition, createReadToolDefinition, createPowerShellToolDefinition,
	createEditToolDefinition, createWriteToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
	ToolExecutionComponent, DefaultResourceLoader, SettingsManager, initTheme, type ExtensionAPI, type ToolRendererResolver, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, getCapabilities, setCapabilities, type TUI } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import packageManifest from "../../package.json";
import toolCards from "../../extensions/tool-cards/index.ts";

initTheme("dark");
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
function resolver() {
	let resolve!: ToolRendererResolver;
	toolCards({ registerToolRenderer(candidate) { resolve = candidate; } } as ExtensionAPI);
	return resolve;
}
// ToolDefinition schemas differ here. Pi's renderer boundary erases their argument types.
function execution(name: string, args: unknown, native?: any, id = name, resolve = resolver()) {
	const renderers = resolve(name, () => native);
	return new ToolExecutionComponent(name, id, args, {}, renderers, { requestRender() {} } as TUI, process.cwd());
}
const result = (text: string, isError = false, details?: unknown) => ({ content: [{ type: "text", text }], isError, details });

test("successful shell calls and output share one rounded inline-header frame without a background band", () => {
	const card = execution("bash", { command: "echo hello" }, createBashToolDefinition(process.cwd()));
	card.updateResult(result("hello"));
	const lines = card.render(40);
	expect(lines.map(plain)).toEqual([
		"", "╭─ BASH / done ────────────────────────╮",
		"│ $ echo hello                         │",
		"│                                      │",
		"│ hello                                │",
		"╰──────────────────────────────────────╯",
	]);
	expect(lines.join("\n")).not.toMatch(/\x1b\[(?:4[0-7]|48;)/);
});

test("tool type fixes every border color while failure alone has a red status highlight", () => {
	for (const [name, native, args, color] of [
		["bash", createBashToolDefinition(process.cwd()), { command: "exit 1" }, 33],
		["powershell", createPowerShellToolDefinition(process.cwd()), { command: "throw 'failed'" }, 33],
		["read", createReadToolDefinition(process.cwd()), { path: "missing.txt" }, 35],
	] as const) {
		const card = execution(name, args, native);
		for (const state of ["running", "done", "FAILED"]) {
			if (state !== "running") card.updateResult(result("output", state === "FAILED"));
			const lines = card.render(40).slice(1);
			expect(plain(lines[0])).toContain(`${name.toUpperCase()} / ${state}`);
			expect(lines[0]).toStartWith(`\x1b[${color}m╭`);
			expect(lines.at(-1)).toStartWith(`\x1b[${color}m╰`);
			for (const line of lines.slice(1, -1)) {
				expect(line).toStartWith(`\x1b[${color}m│\x1b[0m `);
				expect(line).toEndWith(` \x1b[${color}m│\x1b[0m`);
			}
			if (state === "FAILED") expect(lines[0]).toContain("\x1b[41;97;1mFAILED\x1b[0m");
		}
	}
});

test("self-rendered tools, including Shepard cards, pass through without another shell", () => {
	const native: ToolRenderers = {
		renderShell: "self",
		renderCall: () => new Text("╭─ SHEPARD ─╮\n│ crew msg │\n╰──────────╯", 0, 0),
		renderResult: () => new Text("native result", 0, 0),
	};
	for (const name of ["shepard", "bash", "custom-card"]) {
		expect(resolver()(name, () => native)).toBe(native);
		const card = execution(name, {}, native);
		card.updateResult(result("unused"));
		expect(card.render(40).map(line => plain(line).trimEnd())).toEqual(["", "╭─ SHEPARD ─╮", "│ crew msg │", "╰──────────╯", "native result"]);
	}
});

test("Unicode calls and output fit narrow widths and survive resize", () => {
	const card = execution("unicode", { query: "界😀 e\u0301" });
	card.updateResult(result("界😀 e\u0301\nsecond line"));
	card.setExpanded(true);
	for (const width of [0, 1, 2, 3, 4, 5, 6, 9, 20, 60, 6, 40]) {
		for (const line of card.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
	const text = card.render(60).map(plain).join("\n");
	expect(text).toContain("界😀 e\u0301");
	expect(text).toContain("second line");
});

test("inline images are displayed once after the textual frame and image toggles keep native fallbacks", () => {
	const previous = getCapabilities();
	try {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		const card = execution("read", { path: "pixel.png" }, createReadToolDefinition(process.cwd()));
		card.setExpanded(true);
		card.updateResult({ content: [
			{ type: "text", text: "pixel caption" },
			{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2S8AAAAASUVORK5CYII=" },
		], isError: false });
		const lines = card.render(60);
		const images = lines.filter(line => line.includes("]1337;File="));
		expect(images).toHaveLength(1);
		expect(lines.indexOf(images[0])).toBeGreaterThan(lines.findIndex(line => plain(line).startsWith("╰")));
		expect(images[0]).not.toContain("│");
		card.setShowImages(false);
		const hidden = card.render(60).map(plain).join("\n");
		expect(hidden).not.toContain("]1337;File=");
		expect(hidden).toContain("[Image:");
		expect(hidden).toContain("pixel caption");
		card.setShowImages(true);
		expect(card.render(60).filter(line => line.includes("]1337;File="))).toHaveLength(1);
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		card.invalidate();
		expect(card.render(60).map(plain).join("\n")).toContain("[Image:");
	} finally { setCapabilities(previous); }
});

test("native calls, previews, syntax, diffs, warnings and elapsed time survive framing and expansion", () => {
	const cwd = process.cwd();
	for (const [name, native, args, output] of [
		["read", createReadToolDefinition(cwd), { path: "sample.ts" }, result("const value = 1;\n".repeat(15), false, { truncation: { truncated: true, truncatedBy: "lines", outputLines: 15, totalLines: 20 } })],
		["bash", createBashToolDefinition(cwd), { command: "printf output" }, { ...result(Array.from({ length: 15 }, (_, n) => `line ${n}`).join("\n"), false, { truncation: { truncated: true, truncatedBy: "lines", outputLines: 15, totalLines: 20 }, fullOutputPath: "/native/full-output.log" }), durationMs: 2300 }],
		["powershell", createPowerShellToolDefinition(cwd), { command: "Write-Output output" }, { ...result("output"), durationMs: 2300 }],
		["edit", createEditToolDefinition(cwd), { path: "sample.ts", oldText: "old", newText: "new" }, result("edited", false, { diff: "-1 old\n+1 new", firstChangedLine: 1 })],
		["write", createWriteToolDefinition(cwd), { path: "sample.ts", content: "new\n".repeat(15) }, result("wrote file")],
		["grep", createGrepToolDefinition(cwd), { pattern: "value", path: "." }, result("sample.ts:1:value")],
		["find", createFindToolDefinition(cwd), { pattern: "*.ts", path: "." }, result("sample.ts")],
		["ls", createLsToolDefinition(cwd), { path: "." }, result("sample.ts")],
	] as const) {
		const card = execution(name, args, native);
		const baseline = new ToolExecutionComponent(name, name, args, {}, { ...native, renderShell: "self" } as ToolRenderers, { requestRender() {} } as TUI, cwd);
		card.updateResult(output);
		baseline.updateResult(output);
		for (const expanded of [false, true, false]) {
			card.setExpanded(expanded);
			baseline.setExpanded(expanded);
			// Compare ANSI content, not just plain text, against Pi's native rendering at the inner width.
			if (native.renderShell === "self") {
				expect(card.render(80)).toEqual(baseline.render(80));
			} else {
				const body = card.render(80).slice(2, -1).map(line => line.replace(/^\x1b\[\d+m│\x1b\[0m /, "").replace(/ \x1b\[\d+m│\x1b\[0m$/, ""));
				expect(body.map(line => line.trimEnd())).toEqual(baseline.render(76).slice(1).map(line => line.trimEnd()));
			}
		}
		if (name === "bash") {
			const text = card.render(80).map(plain).join("\n");
			expect(text).toContain("earlier lines");
			expect(text).toContain("Full output: /native/full-output.log");
			expect(text).toContain("Took 2.3s");
		}
	}
});

test("partial and concurrent executions keep their own native state and reuse both renderer slots", () => {
	let serial = 0;
	const native: ToolRenderers = {
		renderCall(args, _theme, context) {
			context.state.owner ??= context.toolCallId;
			context.state.callSerial ??= ++serial;
			const text = context.lastComponent ?? new Text("", 0, 0);
			expect(text).toBeInstanceOf(Text);
			(text as Text).setText(`call ${context.state.owner} instance ${context.state.callSerial}: ${(args as { command: string }).command}`);
			context.state.callComponent ??= text;
			expect(text).toBe(context.state.callComponent);
			return text;
		},
		renderResult(output, options, _theme, context) {
			context.state.resultSerial ??= ++serial;
			const text = context.lastComponent ?? new Text("", 0, 0);
			(text as Text).setText(`result ${context.state.owner} instance ${context.state.resultSerial}: ${options.isPartial ? "partial" : "final"} ${(output.content[0] as any)?.text ?? ""}`);
			context.state.resultComponent ??= text;
			expect(text).toBe(context.state.resultComponent);
			return text;
		},
	};
	const resolve = resolver();
	const first = execution("bash", { command: "first" }, native, "one", resolve);
	const second = execution("bash", { command: "second" }, native, "two", resolve);
	first.updateResult(result("chunk one"), true);
	second.updateResult(result("chunk two"), true);
	first.updateArgs({ command: "updated" });
	first.setExpanded(true);
	first.invalidate();
	const firstText = first.render(70).map(plain).join("\n");
	const secondText = second.render(70).map(plain).join("\n");
	expect(firstText).toContain("BASH / running");
	expect(firstText).toContain("call one instance 1: updated");
	expect(firstText).toContain("result one instance 3: partial chunk one");
	expect(firstText).not.toContain("chunk two");
	expect(secondText).toContain("call two instance 2: second");
	expect(secondText).toContain("result two instance 4: partial chunk two");
	first.updateResult(result(""));
	second.updateResult(result("failed", true));
	expect(first.render(70).map(plain).join("\n")).toContain("result one instance 3: final");
	expect(first.render(70).map(plain).join("\n")).toContain("BASH / done");
	expect(second.render(70).map(plain).join("\n")).toContain("BASH / FAILED");
});

test("empty and partial shell output retain one frame and native live timing", () => {
	const card = execution("bash", { command: "sleep 1" }, createBashToolDefinition(process.cwd()));
	card.markExecutionStarted();
	card.setArgsComplete();
	card.updateResult(result(""), true);
	expect(card.render(50).map(plain).join("\n")).toContain("Elapsed");
	card.updateResult({ ...result(""), durationMs: 1000 });
	const text = card.render(50).map(plain).join("\n");
	expect(text).toContain("BASH / done");
	expect(text).toContain("Took 1.0s");
	expect(text.match(/╭/g)).toHaveLength(1);
});

test("native mouse expansion still toggles the outer tool execution", () => {
	const card = execution("bash", { command: "printf lines" }, createBashToolDefinition(process.cwd()));
	card.updateResult(result(Array.from({ length: 15 }, (_, n) => `line ${n}`).join("\n")));
	const before = card.render(60);
	expect(before.map(plain).join("\n")).toContain("earlier lines");
	const click = () => card.handleMouse({ type: "click", button: "left", x: 3, y: 2, screenX: 3, screenY: 2, width: 60, height: card.render(60).length, shift: false, alt: false, ctrl: false });
	expect(click()?.handled).toBe(true);
	const expanded = card.render(60).map(plain).join("\n");
	expect(expanded).not.toContain("earlier lines");
	expect(expanded).toContain("line 0");
	expect(expanded).toContain("line 14");
	expect(click()?.handled).toBe(true);
	expect(card.render(60)).toEqual(before);
});

test("the published extension loads only presentation registration", async () => {
	expect(packageManifest.pi.extensions).toContain("./extensions/tool-cards/index.ts");
	const loader = new DefaultResourceLoader({
		cwd: process.cwd(), agentDir: resolve(process.env.TOOL_CARDS_TEST_DIR ?? ".pi"), settingsManager: SettingsManager.inMemory(),
		additionalExtensionPaths: [resolve("extensions/tool-cards/index.ts")],
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	expect(loaded.errors).toEqual([]);
	expect(loaded.extensions).toHaveLength(1);
	expect(loaded.extensions[0].tools.size).toBe(0);
	expect(loaded.extensions[0].handlers.size).toBe(0);
	expect(loaded.extensions[0].toolRenderers).toHaveLength(1);
});
