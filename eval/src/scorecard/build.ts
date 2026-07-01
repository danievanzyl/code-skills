import type {
  DimensionResult,
  EfficiencyDimensionResult,
  Finding,
  PluginVersion,
  Scorecard,
  Verdict,
} from "../types";

const SECURITY_CHECK = "eval/security";

/** Worst (most severe) verdict across a set. FAIL > WARN > PASS. */
function worst(verdicts: Verdict[]): Verdict {
  if (verdicts.includes("FAIL")) return "FAIL";
  if (verdicts.includes("WARN")) return "WARN";
  return "PASS";
}

export interface BuildInput {
  pr: number;
  sha?: string;
  runId?: string;
  rubricVersion: number;
  generatedAt: string;
  /** Findings from the deterministic security scorer (the v1 gate). */
  securityFindings: Finding[];
  /**
   * Advisory dimensions (budget/scope/process/outcome). Not produced in the
   * first slice; accepted here so they can be wired in without reshaping.
   */
  advisory?: DimensionResult[];
  /**
   * Version stamp — plugin release + agents/skills SHA. Resolved best-effort
   * by the caller; absent fields tolerated. Delta D (#25).
   */
  version?: PluginVersion;
}

/**
 * Assemble the Scorecard. v1 policy (ADR-0001): the security dimension is the
 * only hard gate — any security finding fails eval/security and blocks merge.
 * Advisory dimensions are reported but never gate.
 */
export function buildScorecard(input: BuildInput): Scorecard {
  const securityVerdict: Verdict =
    input.securityFindings.length > 0 ? "FAIL" : "PASS";

  const securityDim: DimensionResult = {
    dimension: "security",
    verdict: securityVerdict,
    gating: true,
    findings: input.securityFindings,
  };

  const advisory = (input.advisory ?? []).map((d) => ({ ...d, gating: false }));
  const dimensions = [securityDim, ...advisory];

  const gateFailed = securityVerdict === "FAIL";
  const description = gateFailed
    ? `${input.securityFindings.length} security finding(s) — see PR comment`
    : "No deterministic security issues found";

  return {
    pr: input.pr,
    sha: input.sha,
    runId: input.runId,
    generatedAt: input.generatedAt,
    rubricVersion: input.rubricVersion,
    ...(input.version !== undefined ? { version: input.version } : {}),
    dimensions,
    gate: {
      check: SECURITY_CHECK,
      state: gateFailed ? "failure" : "success",
      description,
    },
    overall: worst(dimensions.map((d) => d.verdict)),
  };
}

/** Narrow a DimensionResult to EfficiencyDimensionResult, or undefined. */
function asEfficiency(dim: DimensionResult): EfficiencyDimensionResult | undefined {
  if (dim.dimension === "efficiency" && "metrics" in dim) {
    return dim as EfficiencyDimensionResult;
  }
  return undefined;
}

/** Format a token count with commas for readability. */
function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

/** Format wall-clock ms as a human-readable string. */
function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Render per-role efficiency metrics as a compact markdown table row. */
function renderEfficiencyRow(dim: EfficiencyDimensionResult): string {
  const { role, metrics } = dim;
  const wall = metrics.wallClockMs !== undefined ? fmtMs(metrics.wallClockMs) : "—";
  return (
    `| ${role} | ${fmtTokens(metrics.inputTokens)} | ${fmtTokens(metrics.outputTokens)}` +
    ` | ${fmtTokens(metrics.cacheReadTokens)} | ${metrics.toolCallCount} | ${wall} |`
  );
}

/** Render a Scorecard as a Markdown PR comment. */
export function renderMarkdown(card: Scorecard): string {
  const icon: Record<Verdict, string> = {
    PASS: "✅",
    WARN: "⚠️",
    FAIL: "❌",
  };
  const lines: string[] = [];
  lines.push(`## 🤖 Run Evaluator — Scorecard`);
  lines.push("");
  lines.push(
    `**Overall: ${icon[card.overall]} ${card.overall}** · gate \`${card.gate.check}\`: **${card.gate.state}** · rubric v${card.rubricVersion}`,
  );
  if (card.sha) lines.push(`<sub>commit \`${card.sha.slice(0, 12)}\`${card.runId ? ` · run \`${card.runId}\`` : ""}</sub>`);
  lines.push("");

  // Collect efficiency dimensions for grouped rendering.
  const efficiencyDims = card.dimensions
    .map(asEfficiency)
    .filter((d): d is EfficiencyDimensionResult => d !== undefined);

  for (const dim of card.dimensions) {
    const effDim = asEfficiency(dim);
    if (effDim) continue; // rendered separately below

    const tag = dim.gating ? "gating" : "advisory";
    lines.push(`### ${icon[dim.verdict]} ${dim.dimension} (${tag})`);
    if (dim.findings.length === 0) {
      lines.push("_No findings._");
    } else {
      for (const f of dim.findings) {
        lines.push(`- **[${f.severity}] ${f.title}** — ${f.description}`);
        lines.push(`  - where: \`${f.location}\` · evidence: \`${f.evidence}\``);
        lines.push(`  - ${f.recommendation}`);
      }
    }
    lines.push("");
  }

  // Render per-role efficiency as a grouped table (advisory, never gates).
  if (efficiencyDims.length > 0) {
    lines.push(`### ${icon["PASS"]} efficiency (advisory)`);
    lines.push(
      "_Comparative only — not an absolute score. Compare per-issue over time._",
    );
    lines.push("");
    lines.push(
      "| role | input tokens | output tokens | cache reads | tool calls | wall-clock |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const d of efficiencyDims) {
      lines.push(renderEfficiencyRow(d));
    }
    lines.push("");
  }

  lines.push(
    `<sub>Read-only evaluator · does not modify the diff · generated ${card.generatedAt}</sub>`,
  );
  return lines.join("\n");
}
