import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Scorecard } from "./types";

/** Default Scorecard log location. Co-located with the manifest under the same state dir. */
export function defaultScorecardLogPath(): string {
  const stateDir = process.env.RUN_EVAL_STATE_DIR ?? join(homedir(), ".run-eval");
  return join(stateDir, "scorecards.jsonl");
}

/**
 * Append a Scorecard entry to the on-box JSONL log.
 * Append-only; safe under concurrent Runs (each line is atomic at the OS level for
 * reasonably-sized JSON on a local FS). Never throws — errors are suppressed.
 */
export function persistScorecard(
  card: Scorecard,
  logPath: string = defaultScorecardLogPath(),
): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(card) + "\n", "utf8");
  } catch {
    // best-effort — persistence failure must not fail the eval
  }
}

/** Read all Scorecard entries from the log. Returns [] if the log is missing. */
function readAll(logPath: string): Scorecard[] {
  if (!existsSync(logPath)) return [];
  const out: Scorecard[] = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as Scorecard);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** All Scorecards for a given PR, in write order. */
export function scorecardsForPr(
  pr: number,
  logPath: string = defaultScorecardLogPath(),
): Scorecard[] {
  return readAll(logPath).filter((c) => c.pr === pr);
}

/**
 * All Scorecards that carry a specific plugin version string.
 * Matches against `card.version?.plugin`.
 */
export function scorecardsForPluginVersion(
  pluginVersion: string,
  logPath: string = defaultScorecardLogPath(),
): Scorecard[] {
  return readAll(logPath).filter((c) => c.version?.plugin === pluginVersion);
}

/**
 * All Scorecards that carry a specific agents/skills SHA.
 * Matches against `card.version?.sha`. Supports prefix matching (first N chars).
 */
export function scorecardsForSha(
  sha: string,
  logPath: string = defaultScorecardLogPath(),
): Scorecard[] {
  return readAll(logPath).filter((c) => c.version?.sha?.startsWith(sha));
}
