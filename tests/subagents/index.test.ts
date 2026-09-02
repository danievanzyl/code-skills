import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import subagentsExtension from "../../extensions/subagents/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeProjectPersona(frontmatter: string): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
	tempDirs.push(cwd);
	const agentsDir = path.join(cwd, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "runtime-test.md"), `---\nname: runtime-test\n${frontmatter}\n---\n\nTrace the requested code.\n`);
	return cwd;
}

type DispatchOptions = {
	persona?: string;
	scope?: "user" | "project";
	childDelayMs?: number;
	shutdownBeforeCompletion?: boolean;
};

async function runDispatch(cwd: string, params: Record<string, unknown>, options: DispatchOptions = {}) {
	const capturePath = path.join(cwd, "args.json");
	const childPath = path.join(cwd, "fake-pi-child.js");
	const delay = options.childDelayMs
		? `await new Promise((resolve) => setTimeout(resolve, ${options.childDelayMs}));\n`
		: "";
	fs.writeFileSync(childPath, `import fs from "node:fs";\nfs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));\n${delay}console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }));\n`);

	let tool: any;
	let beforeAgentStart: ((event: any) => void) | undefined;
	let sessionShutdown: (() => void) | undefined;
	let completed!: () => void;
	let stale = false;
	let staleEmissions = 0;
	let sentMessages = 0;
	const completion = new Promise<void>((resolve) => { completed = resolve; });
	const pi = {
		events: {
			on() {},
			emit() { if (stale) staleEmissions++; },
		},
		on(event: string, handler: (event: any) => void) {
			if (event === "before_agent_start") beforeAgentStart = handler;
			if (event === "session_shutdown") sessionShutdown = handler;
		},
		registerMessageRenderer() {},
		registerCommand() {},
		registerTool(candidate: any) { tool = candidate; },
		sendMessage() { sentMessages++; completed(); },
	};
	subagentsExtension(pi as any);

	const skillPath = path.join(cwd, "SKILL.md");
	fs.writeFileSync(skillPath, "test skill");
	beforeAgentStart?.({ systemPromptOptions: { skills: [{ name: "parent-skill", filePath: skillPath }] } });

	const originalArgv1 = process.argv[1];
	const originalCapturePath = process.env.CAPTURE_PATH;
	process.argv[1] = childPath;
	process.env.CAPTURE_PATH = capturePath;
	try {
		await tool.execute("call-1", {
			persona: options.persona ?? "runtime-test",
			task: "trace",
			scope: options.scope ?? "project",
			...params,
		}, undefined, undefined, {
			cwd,
			isProjectTrusted: () => true,
			model: { provider: "openai", id: "parent-model" },
			thinkingLevel: "high",
		});
		if (options.shutdownBeforeCompletion) {
			sessionShutdown?.();
			stale = true;
			await Bun.sleep((options.childDelayMs ?? 0) + 100);
		} else {
			await completion;
		}
		const args = fs.existsSync(capturePath) ? JSON.parse(fs.readFileSync(capturePath, "utf8")) : [];
		return { args, staleEmissions, sentMessages };
	} finally {
		process.argv[1] = originalArgv1;
		if (originalCapturePath === undefined) delete process.env.CAPTURE_PATH;
		else process.env.CAPTURE_PATH = originalCapturePath;
	}
}

async function dispatch(cwd: string, params: Record<string, unknown>, options?: DispatchOptions): Promise<string[]> {
	return (await runDispatch(cwd, params, options)).args;
}

describe("subagent persona runtime configuration", () => {
	test("applies persona thinking and skill-inheritance defaults", async () => {
		const cwd = makeProjectPersona("model: pinned-model\nthinking: low\ninheritSkills: false\ntools: read");
		const args = await dispatch(cwd, {});

		expect(args).toContain("--thinking");
		expect(args[args.indexOf("--thinking") + 1]).toBe("low");
		expect(args).not.toContain("--skill");
	});

	test("dispatches the bundled analyzer with its exact runtime defaults", async () => {
		const cwd = makeProjectPersona("");
		const args = await dispatch(cwd, {}, { persona: "codebase-analyzer", scope: "user" });

		expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-luna");
		expect(args[args.indexOf("--thinking") + 1]).toBe("low");
		expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
		expect(args).toContain("--no-extensions");
		expect(args).not.toContain("--skill");
	});

	test("lets an explicit tool-call skill setting override the persona default", async () => {
		const cwd = makeProjectPersona("inheritSkills: false");
		const args = await dispatch(cwd, { inheritSkills: true });

		expect(args).toContain("--no-skills");
		expect(args).toContain("--skill");
	});

	test("lets an explicit false tool-call setting override a true persona default", async () => {
		const cwd = makeProjectPersona("inheritSkills: true");
		const args = await dispatch(cwd, { inheritSkills: false });

		expect(args).not.toContain("--skill");
	});

	test("preserves parent runtime inheritance for personas without new fields", async () => {
		const cwd = makeProjectPersona("tools: read");
		const args = await dispatch(cwd, {});

		expect(args[args.indexOf("--model") + 1]).toBe("openai/parent-model");
		expect(args[args.indexOf("--thinking") + 1]).toBe("high");
		expect(args).toContain("--skill");
	});

	test("leaves thinking unset for a model-pinned persona without a thinking field", async () => {
		const cwd = makeProjectPersona("model: pinned-model");
		const args = await dispatch(cwd, {});

		expect(args[args.indexOf("--model") + 1]).toBe("pinned-model");
		expect(args).not.toContain("--thinking");
	});

	test("does not touch stale extension context after session shutdown", async () => {
		const cwd = makeProjectPersona("");
		const result = await runDispatch(cwd, {}, { childDelayMs: 50, shutdownBeforeCompletion: true });

		expect(result.staleEmissions).toBe(0);
		expect(result.sentMessages).toBe(0);
	});
});
