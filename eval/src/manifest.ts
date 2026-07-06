import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

/** Which agent wrote this entry. Absent role is back-compat treated as "runner". */
export type AgentRole = "runner" | "reviewer";

/** One captured Run, linking a PR to its transcript. Written by the capture hook. */
export interface RunEntry {
  pr: number;
  transcriptPath: string;
  sha?: string;
  runId?: string;
  /** Which hook event recorded it: "Stop" (headless) or "SubagentStop". */
  event?: string;
  /**
   * Agent role that produced this Trajectory.
   * Absent = "runner" for back-compat (legacy capture hook entries).
   */
  role?: AgentRole;
  /** ISO timestamp the entry was written. */
  ts: string;
}

/** Default manifest location. Override with RUN_EVAL_STATE_DIR. */
export function defaultManifestPath(): string {
  const stateDir = process.env.RUN_EVAL_STATE_DIR ?? join(homedir(), ".run-eval");
  return join(stateDir, "manifest.jsonl");
}

/** Append a Run entry. Append-only JSONL is safe under concurrent Runs. */
export function appendRun(entry: RunEntry, path: string = defaultManifestPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

/** All entries for a PR, in write order. */
export function runsForPr(pr: number, path: string = defaultManifestPath()): RunEntry[] {
  if (!existsSync(path)) return [];
  const out: RunEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as RunEntry;
      if (e.pr === pr) out.push(e);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** Latest entry for a PR (last write wins), or null. */
export function latestRunForPr(
  pr: number,
  path: string = defaultManifestPath(),
): RunEntry | null {
  const all = runsForPr(pr, path);
  return all.length ? all[all.length - 1] : null;
}

/**
 * Latest entry for a PR filtered by agent role (last write wins per role).
 * Back-compat: an entry with absent role is treated as "runner".
 */
export function latestRunForPrByRole(
  pr: number,
  role: AgentRole,
  path: string = defaultManifestPath(),
): RunEntry | null {
  const all = runsForPr(pr, path);
  const filtered = all.filter((e) => (e.role ?? "runner") === role);
  return filtered.length ? filtered[filtered.length - 1] : null;
}

/**
 * Latest entry for a PR filtered by agent role, WHOSE transcriptPath exists
 * on disk. Walks back from the newest entry per role, skipping phantom paths
 * (e.g. a SubagentStop advertised a transcript that was never written —
 * 2026-07-06 incident, issue #38). Returns null when no entry for that role
 * has an existing file.
 */
export function latestExistingRunForPrByRole(
  pr: number,
  role: AgentRole,
  path: string = defaultManifestPath(),
  exists: (path: string) => boolean = existsSync,
): RunEntry | null {
  const all = runsForPr(pr, path);
  const filtered = all.filter((e) => (e.role ?? "runner") === role);
  for (let i = filtered.length - 1; i >= 0; i--) {
    if (exists(filtered[i].transcriptPath)) return filtered[i];
  }
  return null;
}
