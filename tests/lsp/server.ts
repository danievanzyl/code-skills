// Fake stdio LSP process. Its wire transcript is the test's observable boundary.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, ResponseError } from "vscode-jsonrpc/node";

const log = (message: unknown) => appendFileSync(join(process.cwd(), "messages.jsonl"), `${JSON.stringify(message)}\n`);
log({ method: "start", args: process.argv.slice(2), cwd: process.cwd(), pid: process.pid });
const startupConfig = existsSync("fake-config.json") ? JSON.parse(readFileSync("fake-config.json", "utf8")) : {};
if (startupConfig.spawnChild) {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	log({ method: "child-start", pid: child.pid });
}
const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
let uri = "";
let text = "";
const item = (name: string) => ({ name, kind: 12, uri, range, selectionRange: range });
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
connection.onNotification((method, params) => {
	log({ method, params });
	if (method === "textDocument/didOpen") { uri = params.textDocument.uri; text = params.textDocument.text; }
	if (method === "textDocument/didChange") text = params.contentChanges[0].text;
	if (method === "exit") process.exit(0);
});
connection.onRequest(async (method, params) => {
	log({ method, params });
	const config = existsSync("fake-config.json") ? JSON.parse(readFileSync("fake-config.json", "utf8")) : {};
	if (method === "shutdown") { if (config.ignoreShutdown) return new Promise(() => {}); return null; }
	if (config.exitOn === method) process.exit(7);
	if (config.hangOn === method) return new Promise(() => {});
	if (config.errorOn === method) throw new ResponseError(-32603, "fake server failure");
	if (config.delayOn === method) await new Promise((resolve) => setTimeout(resolve, 150));
	if (method === "initialize") return { capabilities: config.capabilities ?? { definitionProvider: true, referencesProvider: true, hoverProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true, implementationProvider: true, callHierarchyProvider: true, textDocumentSync: 1 } };
	if (config.empty) return null;
	if (method === "textDocument/definition") return [{ targetUri: uri, targetRange: range, targetSelectionRange: range }];
	if (method === "textDocument/references" || method === "textDocument/implementation") return [{ uri, range }];
	if (method === "textDocument/hover") {
		if (config.applyEdit) {
			const reply = await connection.sendRequest("workspace/applyEdit", { edit: { changes: { [uri]: [{ range, newText: "MUTATED" }] } } });
			log({ method: "edit-response", reply });
		}
		if (config.largeHover) return { contents: { kind: "plaintext", value: "😀".repeat(8_000) + "COMPLETE" } };
		return { contents: [{ language: "typescript", value: text }, { kind: "markdown", value: "**hover**" }, "plain"] };
	}
	if (method === "textDocument/documentSymbol") return [{ name: "parent", kind: 12, range, selectionRange: range, children: [{ name: "child", kind: 13, range, selectionRange: range }] }];
	if (method === "workspace/symbol") return [{ name: params.query, kind: 12, location: { uri, range } }];
	if (method === "textDocument/prepareCallHierarchy") return [item("first"), item("second")];
	if (method === "callHierarchy/incomingCalls") return [{ from: item(`caller-${params.item.name}`), fromRanges: [range] }];
	if (method === "callHierarchy/outgoingCalls") return [{ to: item(`callee-${params.item.name}`), fromRanges: [range] }];
	return null;
});
connection.listen();
