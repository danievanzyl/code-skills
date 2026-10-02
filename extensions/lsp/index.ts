import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { CancellationTokenSource, createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";

const operations = {
	goToDefinition: ["textDocument/definition", "definitionProvider"],
	findReferences: ["textDocument/references", "referencesProvider"],
	hover: ["textDocument/hover", "hoverProvider"],
	documentSymbol: ["textDocument/documentSymbol", "documentSymbolProvider"],
	workspaceSymbol: ["workspace/symbol", "workspaceSymbolProvider"],
	goToImplementation: ["textDocument/implementation", "implementationProvider"],
	prepareCallHierarchy: ["textDocument/prepareCallHierarchy", "callHierarchyProvider"],
	incomingCalls: ["callHierarchy/incomingCalls", "callHierarchyProvider"],
	outgoingCalls: ["callHierarchy/outgoingCalls", "callHierarchyProvider"],
} as const;
const languages: Record<string, [string, string[], string]> = {
	".ts": ["typescript-language-server", ["--stdio"], "typescript"],
	".tsx": ["typescript-language-server", ["--stdio"], "typescriptreact"],
	".go": ["gopls", [], "go"],
	".rs": ["rust-analyzer", [], "rust"],
};
const position = Type.Object({
	line: Type.Integer({ minimum: 1, description: "One-based line" }),
	character: Type.Integer({ minimum: 1, description: "One-based UTF-16 code unit, not byte or Unicode code point" }),
});
const parameters = Type.Object({
	operation: Type.Unsafe<keyof typeof operations>(Type.Union(Object.keys(operations).map((operation) => Type.Literal(operation)))),
	filePath: Type.String({ minLength: 1, description: "Absolute path or relative to session cwd. Also selects the workspaceSymbol server." }),
	position: Type.Optional(position),
	query: Type.Optional(Type.String({ minLength: 1 })),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "UTF-16 text offset for retrieving the next page of a truncated result. Repeat the same request with the returned nextOffset." })),
}, {
	anyOf: Object.keys(operations).map((operation) => ({
		properties: { operation: { const: operation } },
		required: operation === "workspaceSymbol" ? ["query"] : operation === "documentSymbol" ? [] : ["position"],
	})),
});

type Server = {
	connection: MessageConnection;
	documents: Map<string, { text: string; version: number }>;
	capabilities: Record<string, unknown>;
	failure: Promise<never>;
	fail: (error: Error) => void;
	closed: Promise<void>;
};

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error && signal.reason.name !== "AbortError" ? signal.reason : new Error("LSP call cancelled.");
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string, signal?: AbortSignal): Promise<T> {
	let timer!: ReturnType<typeof setTimeout>;
	let abort!: () => void;
	const deadline = new Promise<never>((_accept, reject) => {
		abort = () => reject(abortError(signal!));
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms. Retry to start a fresh server.`)), milliseconds);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
	try { return await Promise.race([promise, deadline]); }
	finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

async function request<T = any>(server: Server, method: string, params: unknown, signal?: AbortSignal, timeout = 30_000): Promise<T> {
	const token = new CancellationTokenSource();
	try {
		if (signal?.aborted) throw abortError(signal);
		return await bounded(Promise.race([server.connection.sendRequest<T>(method, params, token.token), server.failure]), timeout, `LSP ${method}`, signal);
	} catch (error) {
		token.cancel();
		const failure = new Error(`LSP ${method}: ${(error as Error).message}`);
		server.fail(failure);
		throw failure;
	} finally { token.dispose(); }
}

async function notify(server: Server, method: string, params: unknown, signal: AbortSignal): Promise<void> {
	try {
		await bounded(Promise.race([server.connection.sendNotification(method, params), server.failure]), 5_000, `LSP ${method}`, signal);
	} catch (error) { server.fail(error as Error); throw error; }
}

function startServer(command: string, args: string[], cwd: string, evict: (server: Server) => void): Server {
	const child = spawn(command, args, { cwd, shell: false, stdio: "pipe", detached: process.platform !== "win32" });
	const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
	let rejectFailure!: (error: Error) => void;
	let failed = false;
	let stderr = "";
	const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
	failure.catch(() => {});
	const closed = new Promise<void>((accept) => child.once("close", () => accept()));
	const server: Server = {
		connection, documents: new Map(), capabilities: {}, failure, closed,
		fail(error) {
			if (failed) return;
			failed = true;
			evict(server);
			rejectFailure(error);
			connection.dispose();
			// Kill the owned process group too: TypeScript starts a tsserver child.
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch { /* Already exited. */ }
		},
	};
	child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4_000); });
	child.on("error", (error) => server.fail(new Error(`Cannot start ${command}: ${error.message}. Install ${command} and ensure it is on PATH.`)));
	child.on("exit", (code, signal) => server.fail(new Error(`${command} exited (${code ?? signal}). ${stderr} Retry to start a fresh server.`)));
	connection.onError(([error]) => server.fail(new Error(`${command} transport failure: ${error.message}. ${stderr}`)));
	connection.onClose(() => server.fail(new Error(`${command} exited or closed stdio. ${stderr} Retry to start a fresh server.`)));
	connection.onRequest("workspace/applyEdit", () => ({ applied: false, failureReason: "The lsp tool is navigation-only. Workspace edits are rejected." }));
	connection.onRequest("workspace/configuration", (params: { items: unknown[] }) => params.items.map(() => null));
	connection.onRequest("workspace/workspaceFolders", () => [{ uri: pathToFileURL(cwd).href, name: cwd }]);
	connection.onRequest("window/workDoneProgress/create", () => null);
	connection.listen();
	return server;
}

// Keep protocol data in details. Render locations and hover markup without exposing zero-based coordinates.
function render(value: any, documentUri?: string): string {
	if (value == null || (Array.isArray(value) && value.length === 0)) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((item) => render(item, documentUri)).filter(Boolean).join("\n");
	if (value.contents !== undefined) return render(value.contents);
	if (typeof value.value === "string") return value.language ? `\`\`\`${value.language}\n${value.value}\n\`\`\`` : value.value;
	if (value.from || value.to) return `${render(value.from ?? value.to)}\nCall sites: ${JSON.stringify(value.fromRanges.map((range: any) => ({ line: range.start.line + 1, character: range.start.character + 1 })))}`;
	const uri = value.targetUri ?? value.uri ?? value.location?.uri ?? (value.name && value.range ? documentUri : undefined);
	const range = value.targetSelectionRange ?? value.selectionRange ?? value.range ?? value.location?.range;
	let location = "";
	if (uri) {
		location = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
		if (range) location += `:${range.start.line + 1}:${range.start.character + 1}`;
	}
	if (value.name || location) return `${value.name ? `${value.name} ` : ""}${location}${value.children?.length ? `\n${render(value.children, documentUri).split("\n").map((line: string) => `  ${line}`).join("\n")}` : ""}`.trim();
	return JSON.stringify(value, null, 2);
}

export default function lspExtension(pi: ExtensionAPI) {
	const servers = new Map<string, Server>();
	const owned = new Set<Server>();
	let lifecycle = new AbortController();
	let queue: Promise<unknown> = Promise.resolve();
	let shutdown: Promise<void> | undefined;
	const stop = () => {
		if (shutdown) return shutdown;
		lifecycle.abort(new Error("LSP session shutdown."));
		const closing = [...owned];
		for (const server of closing) server.fail(new Error("LSP session shutdown."));
		shutdown = Promise.all(closing.map((server) => bounded(server.closed, 2_000, "LSP process cleanup"))).then(() => {});
		return shutdown;
	};
	pi.on("session_shutdown", stop);
	pi.on("session_start", async () => {
		await stop();
		await queue;
		lifecycle = new AbortController();
		shutdown = undefined;
	});
	pi.registerTool({
		name: "lsp",
		label: "LSP",
		description: "Navigate TypeScript/TSX, Go, and Rust using PATH-installed typescript-language-server, gopls, or rust-analyzer. Reads disk contents. Positions are one-based UTF-16 coordinates. Navigation only, no edits. Server subprocesses are not sandboxed.",
		parameters,
		async execute(_id, params, signal, _update, ctx) {
			const deadline = new AbortController();
			const combined = AbortSignal.any([lifecycle.signal, deadline.signal, ...(signal ? [signal] : [])]);
			const timer = setTimeout(() => deadline.abort(new Error("LSP call timed out after 45000ms, including queue wait.")), 45_000);
			const task = queue.then(async () => {
				if (combined.aborted) throw abortError(combined);
				if (!Check(parameters, params)) throw new Error("Invalid lsp arguments: supply a supported operation, filePath, and its required position or query.");
				const file = resolve(ctx.cwd, params.filePath);
				const language = languages[extname(file)];
				if (!language) throw new Error(`Unsupported file extension ${extname(file) || "(none)"}. Use .ts, .tsx, .go, or .rs.`);
				const [command, args, languageId] = language;
				const text = await readFile(file, { encoding: "utf8", signal: combined }).catch((error) => {
					if (combined.aborted) throw abortError(combined);
					throw new Error(`Cannot read ${file}: ${error.message}`);
				});
				if (combined.aborted) throw abortError(combined);
				if (params.position && params.operation !== "workspaceSymbol" && params.operation !== "documentSymbol") {
					const line = text.split(/\r\n|\n|\r/)[params.position.line - 1];
					if (line === undefined || params.position.character > line.length + 1) throw new Error(`Position outside file ${file}. Characters count UTF-16 code units.`);
				}
				const uri = pathToFileURL(file).href;
				const key = `${ctx.cwd}\0${command}`;
				let server = servers.get(key);
				if (!server) {
					server = startServer(command, args, ctx.cwd, (failed) => { if (servers.get(key) === failed) servers.delete(key); });
					servers.set(key, server);
					owned.add(server);
					server.closed.then(() => owned.delete(server!));
					const initialized = await request(server, "initialize", {
						processId: process.pid, rootUri: pathToFileURL(ctx.cwd).href,
						workspaceFolders: [{ uri: pathToFileURL(ctx.cwd).href, name: ctx.cwd }],
						capabilities: { general: { positionEncodings: ["utf-16"] }, workspace: { configuration: true, workspaceFolders: true, applyEdit: false }, textDocument: { synchronization: {}, callHierarchy: {} } },
					}, combined, 15_000);
					if (!initialized?.capabilities || (initialized.capabilities.positionEncoding && initialized.capabilities.positionEncoding !== "utf-16")) {
						const error = new Error(`${command} returned invalid capabilities or did not negotiate UTF-16 positions.`);
						server.fail(error);
						throw error;
					}
					server.capabilities = initialized.capabilities;
					await notify(server, "initialized", {}, combined);
				}
				const [, capability] = operations[params.operation];
				if (!server.capabilities[capability]) throw new Error(`${command} does not support ${params.operation} (${capability}).`);
				const document = server.documents.get(uri);
				if (!document) {
					await notify(server, "textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } }, combined);
					server.documents.set(uri, { text, version: 1 });
				} else if (document.text !== text) {
					await notify(server, "textDocument/didChange", { textDocument: { uri, version: document.version + 1 }, contentChanges: [{ text }] }, combined);
					server.documents.set(uri, { text, version: document.version + 1 });
				}
				const [method] = operations[params.operation];
				const requestParams: any = params.operation === "workspaceSymbol" ? { query: params.query } : { textDocument: { uri } };
				if (params.position && params.operation !== "workspaceSymbol" && params.operation !== "documentSymbol") requestParams.position = { line: params.position.line - 1, character: params.position.character - 1 };
				if (params.operation === "findReferences") requestParams.context = { includeDeclaration: true };
				let result: any;
				if (params.operation === "incomingCalls" || params.operation === "outgoingCalls") {
					const items = await request<any[]>(server, "textDocument/prepareCallHierarchy", requestParams, combined);
					result = [];
					for (const item of items ?? []) result.push(...await request<any[]>(server, method, { item }, combined) ?? []);
				} else {
					result = await request(server, method, requestParams, combined);
				}
				const output = render(result, uri) || "No results.";
				const offset = params.offset ?? 0;
				let end = Math.min(output.length, offset + 12_000);
				if (end < output.length && /[\uD800-\uDBFF]/.test(output[end - 1])) end--;
				const lines = output.slice(offset, end).split("\n");
				const page = lines.slice(0, 1_000).join("\n");
				const nextOffset = offset + page.length;
				const truncated = nextOffset < output.length;
				const notice = truncated ? `\n\n[Output truncated. Repeat this lsp request with offset: ${nextOffset} to retrieve the next page. Complete protocol result is also in details.result.]` : "";
				return { content: [{ type: "text" as const, text: page + notice }], details: { result, truncated, nextOffset: truncated ? nextOffset : undefined } };
			});
			queue = task.catch(() => {});
			try { return await bounded(task, 45_000, "LSP call", combined); }
			finally { clearTimeout(timer); }
		},
	});
}
