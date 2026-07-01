import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";

export interface PatternRule {
  id: string;
  pattern: string;
  title: string;
}

export interface ReviewerInspectionRubric {
  version: number;
  inspection: {
    /** Tool names that count as inspection (Read, Grep, Glob). */
    read_tools: string[];
    /** Regex patterns matched against Bash command strings to detect test runs. */
    test_patterns: string[];
  };
}

export interface Rubric {
  version: number;
  security: {
    destructive_commands: PatternRule[];
    secret_patterns: PatternRule[];
    egress: { allowlist_hosts: string[] };
  };
  budget: { max_tool_calls: number; max_cost_usd: number };
  scope: { protected_paths: string[] };
  /** Reviewer-specific rubric (separate from Runner rules, ADR-0001 Delta C). */
  reviewer?: ReviewerInspectionRubric;
}

/** Path to the repo's default rubric.yaml. */
export function defaultRubricPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "rubric.yaml");
}

/** Load and lightly validate a Rubric from disk. */
export function loadRubric(path: string = defaultRubricPath()): Rubric {
  const raw = parse(readFileSync(path, "utf8")) as Rubric;
  if (!raw || typeof raw.version !== "number") {
    throw new Error(`Invalid rubric at ${path}: missing numeric "version"`);
  }
  if (!raw.security) {
    throw new Error(`Invalid rubric at ${path}: missing "security" section`);
  }
  // Normalize optional arrays so scorers can assume presence.
  raw.security.destructive_commands ??= [];
  raw.security.secret_patterns ??= [];
  raw.security.egress ??= { allowlist_hosts: [] };
  raw.security.egress.allowlist_hosts ??= [];
  // Normalize reviewer inspection arrays so the rubber-stamp scorer can assume presence.
  if (raw.reviewer) {
    raw.reviewer.inspection ??= { read_tools: [], test_patterns: [] };
    raw.reviewer.inspection.read_tools ??= [];
    raw.reviewer.inspection.test_patterns ??= [];
  }
  return raw;
}
