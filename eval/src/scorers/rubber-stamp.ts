import type { AgentRole } from "../manifest";
import type { DimensionResult, Finding, Trajectory } from "../types";
import type { Rubric } from "../rubric/loader";
import { shellCommands } from "../trajectory/parser";

/** Default read tools when no reviewer rubric section is present. */
const DEFAULT_READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

/** Default test patterns when no reviewer rubric section is present. */
const DEFAULT_TEST_PATTERNS = [
  /\bbun\s+test\b/,
  /\bnpm\s+(run\s+)?test\b/,
  /\byarn\s+test\b/,
  /\bpnpm\s+test\b/,
  /\bpytest\b/,
  /\bgo\s+test\b/,
  /\bcargo\s+test\b/,
  /\bmake\s+test\b/,
];

/**
 * Result for the rubber-stamp process dimension.
 * Advisory, never gates. Always attributed to role=reviewer.
 */
export interface RubberStampDimensionResult extends DimensionResult {
  dimension: "process";
  /** Always "reviewer" — this scorer only applies to Reviewer Trajectories. */
  role: AgentRole;
}

export interface RubberStampInput {
  trajectory: Trajectory;
}

/**
 * Deterministic rubber-stamp scorer (ADR-0001 Delta C, issue #24).
 *
 * "Genuinely reviewed" = evidence of both:
 *   1. A read-tool call (Read / Grep / Glob) — the Reviewer looked at code.
 *   2. A Bash call matching a test-pattern — the Reviewer ran tests.
 *
 * If EITHER signal is missing => advisory WARN (rubber-stamp).
 * Commit count is explicitly NOT a signal — zero commits can be valid.
 * Never gates in v1.
 */
export function scoreRubberStamp(
  input: RubberStampInput,
  rubric: Rubric,
): RubberStampDimensionResult {
  const { trajectory } = input;

  // Resolve read_tools and test_patterns from rubric, falling back to defaults.
  const readTools = rubric.reviewer?.inspection?.read_tools?.length
    ? new Set(rubric.reviewer.inspection.read_tools)
    : DEFAULT_READ_TOOLS;

  const testPatterns: RegExp[] = rubric.reviewer?.inspection?.test_patterns?.length
    ? rubric.reviewer.inspection.test_patterns.map((p) => new RegExp(p))
    : DEFAULT_TEST_PATTERNS;

  // Signal 1: did the Reviewer use any read tool?
  const usedReadTool = trajectory.toolCalls.some((tc) => readTools.has(tc.name));

  // Signal 2: did the Reviewer run any tests? (Bash calls only)
  const cmds = shellCommands(trajectory);
  const ranTests = cmds.some(({ command }) =>
    testPatterns.some((re) => re.test(command)),
  );

  const findings: Finding[] = [];

  if (!usedReadTool) {
    findings.push({
      id: "RUBBER-STAMP-NO-READ-TOOL",
      severity: "MEDIUM",
      category: "PROCESS_QUALITY",
      dimension: "process",
      title: "Reviewer did not use a read tool",
      description:
        "No Read, Grep, or Glob call was found in the Reviewer Trajectory. " +
        "Without inspecting code, the review may be a rubber-stamp.",
      location: "reviewerTrajectory",
      evidence: "No read-tool call (Read / Grep / Glob) in trajectory.",
      recommendation:
        "Ensure the Reviewer reads relevant files before approving or fixing the diff.",
    });
  }

  if (!ranTests) {
    findings.push({
      id: "RUBBER-STAMP-NO-TEST-RUN",
      severity: "MEDIUM",
      category: "PROCESS_QUALITY",
      dimension: "process",
      title: "Reviewer did not run tests",
      description:
        "No test-runner command (bun test, npm test, pytest, etc.) was found in " +
        "the Reviewer Trajectory. Without running tests, the review may be a rubber-stamp.",
      location: "reviewerTrajectory",
      evidence: "No test-runner Bash call matching configured test_patterns in trajectory.",
      recommendation:
        "Ensure the Reviewer runs the project's test suite before approving or fixing the diff.",
    });
  }

  const verdict = findings.length > 0 ? "WARN" : "PASS";

  return {
    dimension: "process",
    verdict,
    gating: false,
    role: "reviewer",
    findings,
  };
}
