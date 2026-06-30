import type {
  DimensionResult,
  Finding,
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
    dimensions,
    gate: {
      check: SECURITY_CHECK,
      state: gateFailed ? "failure" : "success",
      description,
    },
    overall: worst(dimensions.map((d) => d.verdict)),
  };
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

  for (const dim of card.dimensions) {
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
  lines.push(
    `<sub>Read-only evaluator · does not modify the diff · generated ${card.generatedAt}</sub>`,
  );
  return lines.join("\n");
}
