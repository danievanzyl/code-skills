/**
 * Core types for the Run Evaluator.
 *
 * Reuses the skill-vetter Finding/Severity shape so this grafts into
 * pe-ai-skills-hooks later. See docs/adr/0001-post-pr-run-evaluator.md.
 */

/** Severity level for a finding. Lower = more severe. */
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

/** Category of finding. Maps to the part of a Run being scored. */
export type Category =
  | "DESTRUCTIVE_COMMAND"
  | "SECRET_EXPOSURE"
  | "EGRESS_VIOLATION"
  | "BUDGET_EXCEEDED"
  | "SCOPE_CREEP"
  | "PROCESS_QUALITY"
  | "OUTCOME_QUALITY";

/** The dimensions a Run is scored on (see CONTEXT.md). */
export type Dimension =
  | "security"
  | "budget"
  | "scope"
  | "process"
  | "outcome";

/** A single finding produced by a scorer. */
export interface Finding {
  /** Stable id, e.g. "SEC-DESTRUCTIVE-001" */
  id: string;
  severity: Severity;
  category: Category;
  dimension: Dimension;
  /** Short human-readable title */
  title: string;
  /** What was found and why it matters */
  description: string;
  /**
   * Where it was found within the Run — a tool-call index, "diff", etc.
   * Kept loose; this is not a source-file location.
   */
  location: string;
  /** The matched/triggering text. MUST be redacted by scorers — never raw secrets. */
  evidence: string;
  /** What to check or do about it */
  recommendation: string;
}

/** One tool invocation extracted from the Trajectory. */
export interface ToolCall {
  /** tool_use id from the transcript, if present */
  id?: string;
  /** Tool name, e.g. "Bash", "Edit", "Read" */
  name: string;
  /** The tool's input object */
  input: Record<string, unknown>;
  /** Zero-based order in which this call appeared */
  index: number;
}

/**
 * The structured record of what an agent did during a Run.
 * Derived from a Claude Code transcript `.jsonl` (or afk.sh stream-json).
 */
export interface Trajectory {
  sessionId?: string;
  /** All tool calls, in order */
  toolCalls: ToolCall[];
  /** Assistant reasoning/text blocks, in order */
  assistantText: string[];
  /** Token usage totals if the transcript carried them (for budget, later) */
  usage: { inputTokens: number; outputTokens: number };
  /** Number of transcript lines parsed */
  lineCount: number;
}

export type Verdict = "PASS" | "WARN" | "FAIL";

/** Result for one scored dimension. */
export interface DimensionResult {
  dimension: Dimension;
  verdict: Verdict;
  /** Whether this dimension can block a merge in the current policy */
  gating: boolean;
  findings: Finding[];
}

/** The Evaluator's read-only output for one Run. */
export interface Scorecard {
  pr: number;
  sha?: string;
  runId?: string;
  generatedAt: string;
  /** Rubric version used to produce this scorecard */
  rubricVersion: number;
  dimensions: DimensionResult[];
  /** The single hard gate in v1: deterministic security rules */
  gate: {
    check: string; // "eval/security"
    state: "success" | "failure";
    description: string;
  };
  /** Worst verdict across all dimensions */
  overall: Verdict;
}
