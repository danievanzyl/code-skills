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

async function dispatch(cwd: string, params: Record<string, unknown>): Promise<string[]> {
	const capturePath = path.join(cwd, "args.json");
	const childPath = path.join(cwd, "fake-pi-child.js");
	fs.writeFileSync(childPath, `import fs from "node:fs";\nfs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }));\n`);

	let tool: any;
	let beforeAgentStart: ((event: any) => void) | undefined;
	let completed!: () => void;
	const completion = new Promise<void>((resolve) => { completed = resolve; });
	const pi = {
		events: { on() {}, emit() {} },
		on(event: string, handler: (event: any) => void) {
			if (event === "before_agent_start") beforeAgentStart = handler;
		},
		registerMessageRenderer() {},
		registerCommand() {},
		registerTool(candidate: any) { tool = candidate; },
		sendMessage() { completed(); },
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
		await tool.execute("call-1", { persona: "runtime-test", task: "trace", scope: "project", ...params }, undefined, undefined, {
			cwd,
			isProjectTrusted: () => true,
			model: { provider: "openai", id: "parent-model" },
			thinkingLevel: "high",
		});
		await completion;
		return JSON.parse(fs.readFileSync(capturePath, "utf8"));
	} finally {
		process.argv[1] = originalArgv1;
		if (originalCapturePath === undefined) delete process.env.CAPTURE_PATH;
		else process.env.CAPTURE_PATH = originalCapturePath;
	}
}

describe("subagent persona runtime configuration", () => {
	test("applies persona thinking and skill-inheritance defaults", async () => {
		const cwd = makeProjectPersona("model: pinned-model\nthinking: low\ninheritSkills: false\ntools: read");
		const args = await dispatch(cwd, {});

		expect(args).toContain("--thinking");
		expect(args[args.indexOf("--thinking") + 1]).toBe("low");
		expect(args).not.toContain("--skill");
	});

	test("lets an explicit tool-call skill setting override the persona default", async () => {
		const cwd = makeProjectPersona("inheritSkills: false");
		const args = await dispatch(cwd, { inheritSkills: true });

		expect(args).toContain("--no-skills");
		expect(args).toContain("--skill");
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
});
