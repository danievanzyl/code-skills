import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginVersion } from "./types";

/**
 * Best-effort resolution of the plugin release version from plugin.json.
 * Returns undefined if the file is missing or malformed — never throws.
 */
function resolvePluginRelease(repoRoot: string): string | undefined {
  try {
    const pluginJsonPath = join(repoRoot, "plugin.json");
    if (!existsSync(pluginJsonPath)) return undefined;
    const raw = readFileSync(pluginJsonPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const v = parsed.version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort resolution of the git SHA of agents/+skills/ content.
 * Runs `git log --format=%H -n1 -- agents/ skills/` in repoRoot.
 * Returns undefined if git is unavailable, the command fails, or the output is empty.
 * Never throws.
 */
async function resolveAgentsSha(repoRoot: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(
      ["git", "log", "--format=%H", "-n1", "--", "agents/", "skills/"],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (code !== 0) return undefined;
    const sha = out.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the PluginVersion for this Run.
 * Accepts an optional repoRoot for testability (defaults to the directory two levels
 * above this file — i.e. the repo root when running from eval/src/).
 *
 * Best-effort: both fields are optional; missing values tolerated, MUST never throw.
 */
export async function resolveVersion(repoRoot?: string): Promise<PluginVersion> {
  // Default: eval/src/version.ts → eval/src → eval → repo-root
  const root = repoRoot ?? join(import.meta.dirname, "..", "..");
  const [plugin, sha] = await Promise.all([
    Promise.resolve(resolvePluginRelease(root)),
    resolveAgentsSha(root),
  ]);
  const version: PluginVersion = {};
  if (plugin !== undefined) version.plugin = plugin;
  if (sha !== undefined) version.sha = sha;
  return version;
}
