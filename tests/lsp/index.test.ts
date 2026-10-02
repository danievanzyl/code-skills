import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import lspExtension from "../../extensions/lsp/index.ts";
import { Check } from "typebox/value";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const runDir = process.env.LSP_TEST_DIR ?? tmpdir();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function harness() {
	mkdirSync(runDir, { recursive: true });
	const cwd = mkdtempSync(join(runDir, "fake-workspace-"));
	const bin = join(cwd, "bin");
	mkdirSync(bin);
	for (const name of ["typescript-language-server", "gopls", "rust-analyzer"]) {
		writeFileSync(join(bin, name), `#!/bin/sh\nexec '${process.execPath}' '${resolve("tests/lsp/server.ts")}' "$@"\n`, { mode: 0o755 });
	}
	writeFileSync(join(cwd, "sample.ts"), 'const emoji = "😀"; const value = 1;\nvalue;\n');
	let tool: any;
	const handlers: Record<string, Function> = {};
	const tools: any[] = [];
	lspExtension({ registerTool(candidate: any) { tools.push(candidate); tool = candidate; }, on(event: string, handler: Function) { handlers[event] = handler; } } as any);
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	cleanups.push(async () => {
		await handlers.session_shutdown?.();
		process.env.PATH = oldPath;
		rmSync(cwd, { recursive: true, force: true });
	});
	return {
		cwd, tool, tools, handlers,
		config: (config: any) => writeFileSync(join(cwd, "fake-config.json"), JSON.stringify(config)),
		call: (params: any, signal?: AbortSignal, root = cwd) => tool.execute("test", params, signal, undefined, { cwd: root }),
		log: () => existsSync(join(cwd, "messages.jsonl")) ? readFileSync(join(cwd, "messages.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
	};
}

test("Pi loads the explicit entry point without other package extensions or server startup", async () => {
	const h = harness();
	const loader = new DefaultResourceLoader({
		cwd: h.cwd, agentDir: join(h.cwd, "pi-config"), settingsManager: SettingsManager.inMemory(),
		additionalExtensionPaths: [resolve("extensions/lsp/index.ts")],
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	expect(loaded.errors).toEqual([]);
	expect(loaded.extensions).toHaveLength(1);
	expect([...loaded.extensions[0].tools.keys()]).toEqual(["lsp"]);
	expect(h.log()).toEqual([]);
});

test("standalone registration is lazy and definition uses cwd and UTF-16 coordinates", async () => {
	const h = harness();
	expect(h.tools.map((tool) => tool.name)).toEqual(["lsp"]);
	expect(h.log()).toEqual([]);
	const result = await h.call({ operation: "goToDefinition", filePath: "sample.ts", position: { line: 1, character: 26 } });
	expect(result.content[0].text).toContain("sample.ts:1:1");
	const messages = h.log();
	expect(messages[0]).toMatchObject({ method: "start", args: ["--stdio"], cwd: h.cwd });
	expect(messages.find((m) => m.method === "initialize").params.rootUri).toBe(new URL(`file://${h.cwd}`).href);
	expect(messages.map((m) => m.method)).toEqual(["start", "initialize", "initialized", "textDocument/didOpen", "textDocument/definition"]);
	expect(messages.at(-1).params.position).toEqual({ line: 0, character: 25 });
	expect(messages.at(-1).params.textDocument.uri).toBe(new URL(`file://${h.cwd}/sample.ts`).href);
});

test("routes installed servers, reuses by language/root, and synchronizes disk changes", async () => {
	const h = harness();
	for (const file of ["sample.tsx", "sample.go", "sample.rs"]) writeFileSync(join(h.cwd, file), "value");
	const params = { operation: "goToDefinition", filePath: "sample.ts", position: { line: 1, character: 1 } };
	await h.call(params);
	await h.call(params);
	writeFileSync(join(h.cwd, "sample.ts"), "updated");
	await h.call(params);
	await h.call({ ...params, filePath: "sample.tsx" });
	await h.call({ ...params, filePath: "sample.go" });
	await h.call({ ...params, filePath: "sample.rs" });
	const otherRoot = join(h.cwd, "other");
	mkdirSync(otherRoot);
	writeFileSync(join(otherRoot, "sample.ts"), "other");
	await h.call(params, undefined, otherRoot);
	const messages = h.log();
	expect(messages.filter((m) => m.method === "start").map((m) => m.args)).toEqual([["--stdio"], [], []]);
	expect(messages.filter((m) => m.method === "textDocument/didOpen").map((m) => m.params.textDocument.languageId)).toEqual(["typescript", "typescriptreact", "go", "rust"]);
	expect(messages.filter((m) => m.method === "textDocument/didChange")).toEqual([
		{ method: "textDocument/didChange", params: { textDocument: { uri: new URL(`file://${h.cwd}/sample.ts`).href, version: 2 }, contentChanges: [{ text: "updated" }] } },
	]);
	expect(readFileSync(join(otherRoot, "messages.jsonl"), "utf8")).toContain('"method":"start"');
});

test("all nine operations render their LSP result shapes and calls prepare every hierarchy item", async () => {
	const h = harness();
	const operations = ["goToDefinition", "findReferences", "hover", "documentSymbol", "workspaceSymbol", "goToImplementation", "prepareCallHierarchy", "incomingCalls", "outgoingCalls"];
	const expected = ["sample.ts:1:1", "sample.ts:1:1", "😀", "child", "needle", "sample.ts:1:1", "second", "caller-second", "callee-second"];
	for (let index = 0; index < operations.length; index++) {
		const result = await h.call({ operation: operations[index], filePath: "sample.ts", position: { line: 2, character: 1 }, query: "needle" });
		expect(result.content[0].text).toContain(expected[index]);
		expect(result.details.result).toBeDefined();
		if (operations[index] === "documentSymbol") expect(result.content[0].text).toContain("parent " + join(h.cwd, "sample.ts") + ":1:1");
	}
	const messages = h.log();
	expect(messages.find((m) => m.method === "textDocument/references").params.context).toEqual({ includeDeclaration: true });
	expect(messages.find((m) => m.method === "workspace/symbol").params).toEqual({ query: "needle" });
	expect(messages.filter((m) => m.method === "callHierarchy/incomingCalls").map((m) => m.params.item.name)).toEqual(["first", "second"]);
	expect(messages.filter((m) => m.method === "callHierarchy/outgoingCalls").map((m) => m.params.item.name)).toEqual(["first", "second"]);
	writeFileSync(join(h.cwd, "fake-config.json"), JSON.stringify({ empty: true }));
	for (const operation of operations) {
		const result = await h.call({ operation, filePath: "sample.ts", position: { line: 1, character: 1 }, query: "none" });
		expect(result.content[0].text).toBe("No results.");
	}
});

test("schema and execution reject invalid arguments, missing files, and out-of-file positions", async () => {
	const h = harness();
	expect(h.tool.parameters.type).toBe("object");
	expect(h.tool.parameters.properties.operation.anyOf.map((branch: any) => branch.const)).toEqual(["goToDefinition", "findReferences", "hover", "documentSymbol", "workspaceSymbol", "goToImplementation", "prepareCallHierarchy", "incomingCalls", "outgoingCalls"]);
	for (const operation of ["goToDefinition", "findReferences", "hover", "goToImplementation", "prepareCallHierarchy", "incomingCalls", "outgoingCalls"]) {
		expect(Check(h.tool.parameters, { operation, filePath: "sample.ts" })).toBe(false);
		expect(Check(h.tool.parameters, { operation, filePath: "sample.ts", position: { line: 1, character: 1 } })).toBe(true);
	}
	expect(Check(h.tool.parameters, { operation: "workspaceSymbol", filePath: "sample.ts" })).toBe(false);
	expect(Check(h.tool.parameters, { operation: "workspaceSymbol", filePath: "sample.ts", query: "value" })).toBe(true);
	expect(Check(h.tool.parameters, { operation: "documentSymbol", filePath: "sample.ts" })).toBe(true);
	for (const position of [{ line: 0, character: 1 }, { line: 1, character: -1 }, { line: 1.5, character: 1 }]) {
		expect(Check(h.tool.parameters, { operation: "hover", filePath: "sample.ts", position })).toBe(false);
		await expect(h.call({ operation: "hover", filePath: "sample.ts", position })).rejects.toThrow("Invalid lsp arguments");
	}
	await expect(h.call({ operation: "rename", filePath: "sample.ts" })).rejects.toThrow("Invalid lsp arguments");
	await expect(h.call({ operation: "hover", filePath: "sample.ts" })).rejects.toThrow("Invalid lsp arguments");
	await expect(h.call({ operation: "workspaceSymbol", filePath: "sample.ts" })).rejects.toThrow("Invalid lsp arguments");
	await expect(h.call({ operation: "documentSymbol", filePath: "sample.py" })).rejects.toThrow("Unsupported file extension .py");
	await expect(h.call({ operation: "documentSymbol", filePath: "missing.ts" })).rejects.toThrow("Cannot read");
	for (const position of [{ line: 20, character: 1 }, { line: 1, character: 80 }]) {
		await expect(h.call({ operation: "hover", filePath: "sample.ts", position })).rejects.toThrow("Position outside file");
	}
	expect(h.log()).toEqual([]);
});

test("advertised unsupported operations and non-UTF-16 encoding fail explicitly", async () => {
	const h = harness();
	writeFileSync(join(h.cwd, "fake-config.json"), JSON.stringify({ capabilities: { hoverProvider: false } }));
	await expect(h.call({ operation: "hover", filePath: "sample.ts", position: { line: 1, character: 1 } })).rejects.toThrow("does not support hover");
	await expect(h.call({ operation: "incomingCalls", filePath: "sample.ts", position: { line: 1, character: 1 } })).rejects.toThrow("does not support incomingCalls");
	expect(h.log().some((m) => m.method === "textDocument/hover" || m.method === "textDocument/prepareCallHierarchy")).toBe(false);
	const otherRoot = join(h.cwd, "utf8");
	mkdirSync(otherRoot);
	writeFileSync(join(otherRoot, "sample.ts"), "value");
	writeFileSync(join(otherRoot, "fake-config.json"), JSON.stringify({ capabilities: { positionEncoding: "utf-8", definitionProvider: true } }));
	await expect(h.call({ operation: "goToDefinition", filePath: "sample.ts", position: { line: 1, character: 1 } }, undefined, otherRoot)).rejects.toThrow("UTF-16");
});

const hoverParams = { operation: "hover", filePath: "sample.ts", position: { line: 1, character: 1 } };
async function waitFor(check: () => boolean) {
	for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await Bun.sleep(10); }
	throw new Error("Fake server did not reach expected protocol state");
}
function isAlive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

test("parallel calls serialize through initialization and cancellation does not hang or poison the queue", async () => {
	const h = harness();
	h.config({ delayOn: "initialize" });
	await Promise.all([h.call(hoverParams), h.call(hoverParams)]);
	expect(h.log().filter((m) => m.method === "start")).toHaveLength(1);
	expect(h.log().filter((m) => m.method === "textDocument/didOpen")).toHaveLength(1);
	expect(h.log().map((m) => m.method).indexOf("initialized")).toBeLessThan(h.log().map((m) => m.method).indexOf("textDocument/hover"));
	h.config({ hangOn: "textDocument/hover" });
	const active = new AbortController();
	const pending = h.call(hoverParams, active.signal);
	pending.catch(() => {});
	await waitFor(() => h.log().filter((m) => m.method === "textDocument/hover").length === 3);
	const queued = new AbortController();
	const queuedCall = h.call(hoverParams, queued.signal);
	queuedCall.catch(() => {});
	queued.abort();
	await expect(queuedCall).rejects.toThrow("cancelled");
	active.abort();
	await expect(pending).rejects.toThrow("cancelled");
	h.config({});
	expect((await h.call(hoverParams)).content[0].text).toContain("😀");
	expect(h.log().filter((m) => m.method === "start")).toHaveLength(2);
	const preAborted = new AbortController();
	preAborted.abort();
	await expect(h.call(hoverParams, preAborted.signal)).rejects.toThrow("cancelled");
});

test("initialization failure and unexpected exit clear the connection for the next call", async () => {
	const h = harness();
	h.config({ errorOn: "initialize" });
	await expect(h.call(hoverParams)).rejects.toThrow("initialize");
	h.config({ exitOn: "textDocument/hover" });
	await expect(h.call(hoverParams)).rejects.toThrow("exited");
	h.config({});
	expect((await h.call(hoverParams)).content[0].text).toContain("😀");
	expect(h.log().filter((m) => m.method === "start")).toHaveLength(3);
});

test("missing PATH executable is actionable and recoverable", async () => {
	const h = harness();
	rmSync(join(h.cwd, "bin/typescript-language-server"));
	const normalPath = process.env.PATH;
	process.env.PATH = join(h.cwd, "bin");
	try {
		await expect(h.call(hoverParams)).rejects.toThrow("Install typescript-language-server");
	} finally { process.env.PATH = normalPath; }
	writeFileSync(join(h.cwd, "bin/typescript-language-server"), `#!/bin/sh\nexec '${process.execPath}' '${resolve("tests/lsp/server.ts")}' "$@"\n`, { mode: 0o755 });
	expect((await h.call(hoverParams)).content[0].text).toContain("😀");
});

test("shutdown rejects active and queued calls, reaps processes, and is idempotent", async () => {
	const h = harness();
	h.config({ hangOn: "textDocument/hover", ignoreShutdown: true, spawnChild: true });
	const pending = h.call(hoverParams);
	pending.catch(() => {});
	await waitFor(() => h.log().some((m) => m.method === "textDocument/hover"));
	const queued = h.call(hoverParams);
	queued.catch(() => {});
	const pids = h.log().filter((m) => m.method === "start" || m.method === "child-start").map((m) => m.pid);
	expect(pids).toHaveLength(2);
	await h.handlers.session_shutdown();
	await expect(pending).rejects.toThrow("shutdown");
	await expect(queued).rejects.toThrow("shutdown");
	await h.handlers.session_shutdown();
	await waitFor(() => pids.every((pid) => !isAlive(pid)));
	expect(pids.every((pid) => !isAlive(pid))).toBe(true);
	await expect(h.call(hoverParams)).rejects.toThrow("shutdown");
	await h.handlers.session_start();
	h.config({});
	expect((await h.call(hoverParams)).content[0].text).toContain("😀");
});

test("server-requested workspace edits are rejected and source contents are unchanged", async () => {
	const h = harness();
	const before = readFileSync(join(h.cwd, "sample.ts"), "utf8");
	h.config({ applyEdit: true });
	await h.call(hoverParams);
	expect(h.log().find((m) => m.method === "edit-response").reply).toEqual({ applied: false, failureReason: "The lsp tool is navigation-only. Workspace edits are rejected." });
	expect(readFileSync(join(h.cwd, "sample.ts"), "utf8")).toBe(before);
});

test("large output is explicitly truncated and complete readable results can be paged", async () => {
	const h = harness();
	h.config({ largeHover: true });
	const first = await h.call(hoverParams);
	expect(first.details.truncated).toBe(true);
	expect(first.content[0].text).toContain("truncated");
	expect(first.content[0].text).toContain("offset: 12000");
	const second = await h.call({ ...hoverParams, offset: first.details.nextOffset });
	expect(second.details.truncated).toBe(false);
	expect(second.content[0].text).toEndWith("COMPLETE");
	expect(first.content[0].text.split("\n\n[Output")[0] + second.content[0].text).toBe("😀".repeat(8_000) + "COMPLETE");
	expect(first.details.result.contents.value).toEndWith("COMPLETE");
});

test("initialization and navigation timeouts fail promptly and restart on retry", async () => {
	const h = harness();
	h.config({ hangOn: "initialize" });
	await expect(h.call(hoverParams)).rejects.toThrow("initialize timed out after 15000ms");
	h.config({ hangOn: "textDocument/hover" });
	await expect(h.call(hoverParams)).rejects.toThrow("textDocument/hover timed out after 30000ms");
	h.config({});
	expect((await h.call(hoverParams)).content[0].text).toContain("😀");
	expect(h.log().filter((m) => m.method === "start")).toHaveLength(3);
}, 50_000);
