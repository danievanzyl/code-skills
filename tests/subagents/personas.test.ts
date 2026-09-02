import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverPersonas } from "../../extensions/subagents/personas.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function projectPersona(frontmatter: string): ReturnType<typeof discoverPersonas>[number] {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-persona-test-"));
	tempDirs.push(cwd);
	const agentsDir = path.join(cwd, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "test-persona.md"), `---\n${frontmatter}\n---\n\nTest prompt.\n`);
	return discoverPersonas(cwd, "project")[0];
}

describe("discoverPersonas runtime configuration", () => {
	test("discovers valid persona thinking and skill-inheritance defaults", () => {
		const persona = projectPersona("name: test-persona\nthinking: low\ninheritSkills: false");

		expect(persona.thinking).toBe("low");
		expect(persona.inheritSkills).toBe(false);
	});

	test("ignores invalid runtime values without dropping the persona", () => {
		const persona = projectPersona("name: test-persona\nthinking: extreme\ninheritSkills: no");

		expect(persona).toMatchObject({ name: "test-persona", thinking: undefined, inheritSkills: undefined });
	});

	test("discovers the bundled codebase analyzer with scoped runtime configuration", () => {
		const persona = discoverPersonas(process.cwd(), "user")
			.find((candidate) => candidate.name === "codebase-analyzer" && candidate.source === "pi-package");

		expect(persona).toMatchObject({
			model: "gpt-5.6-luna",
			thinking: "low",
			inheritSkills: false,
			tools: ["read", "grep", "find", "ls"],
		});
	});
});
