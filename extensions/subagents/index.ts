import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	STATUS_REQUEST_EVENT,
	invalidateStatusSection,
	publishStatusSection,
	removeStatusSection,
	type StatusSection,
} from "../status-window/api.ts";
import { discoverPersonas, type Persona, type PersonaScope } from "./personas.ts";

const MAX_REPORT_BYTES = 50 * 1024;

type UsageStats = {
	input: number;
	output: number;
	context: number;
	turns: number;
};

type RunDetails = {
	jobId: string;
	persona: string;
	source: Persona["source"];
	filePath: string;
	task: string;
	model?: string;
	inheritedSkills: string[];
	exitCode: number;
	wallTimeMs: number;
	usage: UsageStats;
};

type Job = {
	id: string;
	persona: string;
	task: string;
	startedAt: number;
	model?: string;
	usage: UsageStats;
	controller: AbortController;
};

function formatCount(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const executable = path.basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(executable)
		? { command: "pi", args }
		: { command: process.execPath, args };
}

function textFrom(message: Message): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function capReport(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= MAX_REPORT_BYTES) return text;
	let end = Math.min(text.length, MAX_REPORT_BYTES);
	while (Buffer.byteLength(text.slice(0, end), "utf8") > MAX_REPORT_BYTES) end--;
	return `${text.slice(0, end)}\n\n[Subagent report truncated to 50 KB.]`;
}

async function writeSystemPrompt(persona: Persona): Promise<{ dir: string; file: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-persona-"));
	const file = path.join(dir, "SYSTEM.md");
	const prompt = `${persona.prompt}\n\n# Subagent contract\n\nWork only on the delegated task. Your conversation is isolated from the parent agent. When finished, return a concise report containing the result, important evidence, files changed, and any unresolved issues. Do not ask the parent follow-up questions unless the task cannot proceed.`;
	await fs.promises.writeFile(file, prompt, { encoding: "utf8", mode: 0o600 });
	return { dir, file };
}

async function runPersona(options: {
	jobId: string;
	persona: Persona;
	task: string;
	cwd: string;
	parentModel?: string;
	thinkingLevel?: ThinkingLevel;
	skills: Skill[];
	inheritSkills: boolean;
	signal: AbortSignal;
	onProgress: (usage: UsageStats) => void;
}): Promise<{ report: string; stderr: string; details: RunDetails }> {
	const { jobId, persona, task, cwd, parentModel, thinkingLevel, skills, inheritSkills, signal, onProgress } = options;
	const startedAt = Date.now();
	const temp = await writeSystemPrompt(persona);
	const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", temp.file, "--exclude-tools", "subagent"];
	const model = persona.model ?? parentModel;
	if (model) args.push("--model", model);
	if (!persona.model && thinkingLevel) args.push("--thinking", thinkingLevel);
	if (persona.tools !== undefined) {
		if (persona.tools.length) args.push("--tools", persona.tools.join(","));
		else args.push("--no-tools");
	}

	const inheritedSkills = inheritSkills ? skills.filter((skill) => fs.existsSync(skill.filePath)) : [];
	if (inheritSkills) {
		args.push("--no-skills");
		for (const skill of inheritedSkills) args.push("--skill", skill.filePath);
	}
	args.push(`Task delegated by the parent agent:\n\n${task}`);

	let stderr = "";
	let buffer = "";
	let finalReport = "";
	const usage: UsageStats = { input: 0, output: 0, context: 0, turns: 0 };
	let aborted = false;

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = piInvocation(args);
			const child = spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let closed = false;
			let killTimer: NodeJS.Timeout | undefined;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line) as { type?: string; message?: Message };
					if (event.type === "message_end" && event.message?.role === "assistant") {
						usage.turns++;
						const messageUsage = event.message.usage;
						if (messageUsage) {
							usage.input += messageUsage.input || 0;
							usage.output += messageUsage.output || 0;
							usage.context = messageUsage.totalTokens || 0;
						}
						const text = textFrom(event.message);
						if (text) finalReport = text;
						onProgress({ ...usage });
					}
				} catch {
					// Ignore non-event stdout diagnostics.
				}
			};

			child.stdout.on("data", (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
			child.on("error", (error) => { stderr += `${error.message}\n`; });
			child.on("close", (code) => {
				closed = true;
				if (killTimer) clearTimeout(killTimer);
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 1);
			});

			const abort = () => {
				aborted = true;
				child.kill("SIGTERM");
				killTimer = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 5000);
				killTimer.unref();
			};
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		});

		if (aborted) throw new Error("Subagent was aborted");
		const report = finalReport || stderr.trim() || "(subagent produced no report)";
		return {
			report: capReport(exitCode === 0 ? report : `Subagent exited with code ${exitCode}.\n\n${report}`),
			stderr,
			details: {
				jobId,
				persona: persona.name,
				source: persona.source,
				filePath: persona.filePath,
				task,
				model,
				inheritedSkills: inheritedSkills.map((skill) => skill.name),
				exitCode,
				wallTimeMs: Date.now() - startedAt,
				usage,
			},
		};
	} finally {
		await fs.promises.rm(temp.dir, { recursive: true, force: true });
	}
}

const ScopeSchema = StringEnum(["user", "project", "both"] as const);

export default function subagentsExtension(pi: ExtensionAPI) {
	let currentSkills: Skill[] = [];
	let nextJobId = 1;
	let shuttingDown = false;
	const jobs = new Map<string, Job>();
	let statusTimer: NodeJS.Timeout | undefined;

	const section: StatusSection = {
		id: "subagents",
		priority: 100,
		visible: () => jobs.size > 0,
		getSnapshot: () => ({
			title: `Subagents (${jobs.size})`,
			icon: "󰚩",
			rows: [...jobs.values()].flatMap((job) => [
				{ icon: "●", text: `${job.persona} · ${formatDuration(Date.now() - job.startedAt)}`, tone: "warning" as const },
				{ text: `ctx ${formatCount(job.usage.context)}  ↑ ${formatCount(job.usage.input)}  ↓ ${formatCount(job.usage.output)}`, tone: "dim" as const, indent: 2 },
			]),
			footer: "/subagent-cancel <job|all>",
		}),
	};
	const publish = () => publishStatusSection(pi, section);
	pi.events.on(STATUS_REQUEST_EVENT, publish);

	const updateStatus = () => {
		if (jobs.size > 0 && !statusTimer) {
			statusTimer = setInterval(() => invalidateStatusSection(pi, section.id), 1000);
			statusTimer.unref();
		} else if (jobs.size === 0 && statusTimer) {
			clearInterval(statusTimer);
			statusTimer = undefined;
		}
		invalidateStatusSection(pi, section.id);
	};

	pi.on("before_agent_start", (event) => {
		currentSkills = [...(event.systemPromptOptions.skills ?? [])];
	});

	pi.on("session_start", () => {
		shuttingDown = false;
		publish();
	});

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		for (const job of jobs.values()) job.controller.abort();
		jobs.clear();
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
		removeStatusSection(pi, section.id);
	});

	pi.registerMessageRenderer("subagent-complete", (message, { expanded, outputPad }, theme) => {
		const details = message.details as RunDetails | undefined;
		const status = details?.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
		const heading = `${status} ${theme.fg("accent", theme.bold(details?.persona ?? "subagent"))} ${theme.fg("muted", details ? formatDuration(details.wallTimeMs) : "")}`;
		const content = typeof message.content === "string"
			? message.content
			: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		const body = expanded ? content : content.split("\n").slice(0, 10).join("\n");
		return new Text(`${heading}\n${body}`, outputPad, 0);
	});

	pi.registerCommand("subagents", {
		description: "List available Markdown subagent personas",
		handler: async (args, ctx) => {
			const scope = (["user", "project", "both"].includes(args.trim()) ? args.trim() : "user") as PersonaScope;
			const personas = discoverPersonas(ctx.cwd, scope);
			const text = personas.length
				? personas.map((persona) => `${persona.name} [${persona.source}] — ${persona.description}`).join("\n")
				: "No subagent personas found.";
			ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("subagent-cancel", {
		description: "Cancel a background subagent by job id, or all jobs",
		handler: async (args, ctx) => {
			const target = args.trim();
			const selected = target === "all" ? [...jobs.values()] : jobs.has(target) ? [jobs.get(target)!] : [];
			for (const job of selected) job.controller.abort();
			ctx.ui.notify(selected.length ? `Cancelling ${selected.length} subagent job(s)` : `No matching subagent job: ${target}`, selected.length ? "info" : "warning");
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Start a Markdown persona in an isolated background pi process. Returns immediately; completion is delivered to the parent context as a follow-up message. Personas are bundled with the package and can be overridden from ~/.pi/agent/agents/*.md.",
		promptSnippet: "Start focused work in a non-blocking isolated Markdown-defined subagent",
		promptGuidelines: ["Use subagent for focused delegated work. It runs asynchronously; continue useful parent work after dispatch and incorporate the completion message when it arrives."],
		parameters: Type.Object({
			list: Type.Optional(Type.Boolean({ description: "List available personas without running one" })),
			persona: Type.Optional(Type.String({ description: "Persona name from a Markdown file; required unless list is true" })),
			task: Type.Optional(Type.String({ description: "Self-contained task and expected report; required unless list is true" })),
			scope: Type.Optional(ScopeSchema),
			inheritSkills: Type.Optional(Type.Boolean({ description: "Pass exactly the parent context's loaded skills to the child (default true)" })),
			cwd: Type.Optional(Type.String({ description: "Child working directory; defaults to the parent cwd" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const scope: PersonaScope = params.scope ?? "user";
			if (scope !== "user" && !ctx.isProjectTrusted()) throw new Error("Project-local personas require a trusted project");
			const personas = discoverPersonas(ctx.cwd, scope);
			if (params.list) {
				const listing = personas.length
					? personas.map((item) => `${item.name} [${item.source}] — ${item.description}`).join("\n")
					: "No subagent personas found.";
				return { content: [{ type: "text", text: listing }], details: undefined };
			}
			if (!params.persona || !params.task) throw new Error("persona and task are required unless list is true");
			const persona = personas.find((candidate) => candidate.name === params.persona);
			if (!persona) throw new Error(`Unknown persona '${params.persona}'. Available: ${personas.map((item) => item.name).join(", ") || "none"}`);

			const id = `sa-${nextJobId++}`;
			const controller = new AbortController();
			const job: Job = {
				id,
				persona: persona.name,
				task: params.task,
				startedAt: Date.now(),
				model: persona.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
				usage: { input: 0, output: 0, context: 0, turns: 0 },
				controller,
			};
			jobs.set(id, job);
			updateStatus();

			void runPersona({
				jobId: id,
				persona,
				task: params.task,
				cwd: params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd,
				parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
				skills: [...currentSkills],
				inheritSkills: params.inheritSkills ?? true,
				signal: controller.signal,
				onProgress: (usage) => {
					job.usage = usage;
					updateStatus();
				},
			}).then((result) => {
				jobs.delete(id);
				updateStatus();
				if (shuttingDown) return;
				pi.sendMessage({
					customType: "subagent-complete",
					content: `Background subagent ${persona.name} completed job ${id}. Treat this report as delegated evidence and continue the user's task.\n\n${result.report}`,
					display: true,
					details: result.details,
				}, { deliverAs: "followUp", triggerTurn: true });
			}).catch((error: unknown) => {
				jobs.delete(id);
				updateStatus();
				if (shuttingDown) return;
				const message = error instanceof Error ? error.message : String(error);
				pi.sendMessage({
					customType: "subagent-complete",
					content: `Background subagent ${persona.name} failed job ${id}: ${message}`,
					display: true,
					details: { jobId: id, persona: persona.name, exitCode: 1, wallTimeMs: Date.now() - job.startedAt, usage: job.usage },
				}, { deliverAs: "followUp", triggerTurn: true });
			});

			return {
				content: [{ type: "text", text: `Started background subagent ${persona.name} as ${id}. It will report back automatically; continue with other work.` }],
				details: { jobId: id, persona: persona.name, startedAt: job.startedAt },
			};
		},
		renderCall(args, theme) {
			if (args.list) return new Text(theme.fg("toolTitle", theme.bold("subagent list")), 0, 0);
			const rawTask = args.task ?? "...";
			const task = rawTask.length > 80 ? `${rawTask.slice(0, 80)}…` : rawTask;
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.persona ?? "...")}\n${theme.fg("dim", task)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content.find((part) => part.type === "text");
			return new Text(theme.fg("success", text?.type === "text" ? text.text : "Started"), 0, 0);
		},
	});
}
