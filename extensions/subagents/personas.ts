import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type PersonaScope = "user" | "project" | "both";

export interface Persona {
	name: string;
	description: string;
	prompt: string;
	model?: string;
	tools?: string[];
	filePath: string;
	source: "pi-package" | "pi-user" | "pi-project";
}

type PersonaFrontmatter = {
	name?: unknown;
	description?: unknown;
	model?: unknown;
	tools?: unknown;
};

const TOOL_ALIASES: Record<string, string | undefined> = {
	bash: "bash",
	read: "read",
	write: "write",
	edit: "edit",
	multiedit: "edit",
	grep: "grep",
	glob: "find",
	find: "find",
	ls: "ls",
};

function parseTools(value: unknown): string[] | undefined {
	if (!Array.isArray(value) && typeof value !== "string") return undefined;
	const raw = Array.isArray(value) ? value : value.split(",");
	const tools = raw
		.filter((item): item is string => typeof item === "string")
		.map((item) => TOOL_ALIASES[item.trim().toLowerCase()])
		.filter((item): item is string => Boolean(item));
	return [...new Set(tools)];
}

function loadDirectory(dir: string, source: Persona["source"]): Persona[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const personas: Persona[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const filePath = path.join(dir, entry.name);
		try {
			const content = fs.readFileSync(filePath, "utf8");
			const { frontmatter, body } = parseFrontmatter<PersonaFrontmatter>(content);
			const fallbackName = path.basename(entry.name, ".md");
			const name = typeof frontmatter.name === "string" && frontmatter.name.trim()
				? frontmatter.name.trim()
				: fallbackName;
			const description = typeof frontmatter.description === "string"
				? frontmatter.description.trim()
				: `Subagent persona loaded from ${entry.name}`;
			personas.push({
				name,
				description,
				prompt: body.trim(),
				model: typeof frontmatter.model === "string" && frontmatter.model !== "inherit"
					? frontmatter.model
					: undefined,
				tools: parseTools(frontmatter.tools),
				filePath,
				source,
			});
		} catch {
			// A malformed persona must not prevent other personas from loading.
		}
	}
	return personas;
}

function nearestDirectory(cwd: string, relativeParts: string[]): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, ...relativeParts);
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// Keep walking.
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function discoverPersonas(cwd: string, scope: PersonaScope): Persona[] {
	const groups: Persona[][] = [];
	if (scope !== "project") {
		const packageAgentsDir = path.join(__dirname, "agents");
		groups.push(loadDirectory(packageAgentsDir, "pi-package"));
		groups.push(loadDirectory(path.join(getAgentDir(), "agents"), "pi-user"));
	}
	if (scope !== "user") {
		const piDir = nearestDirectory(cwd, [CONFIG_DIR_NAME, "agents"]);
		if (piDir) groups.push(loadDirectory(piDir, "pi-project"));
	}

	const byName = new Map<string, Persona>();
	for (const group of groups) for (const persona of group) byName.set(persona.name, persona);
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
