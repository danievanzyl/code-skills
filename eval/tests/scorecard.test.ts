import { test, expect } from "bun:test";
import { buildScorecard, renderMarkdown } from "../src/scorecard/build";
import type { EfficiencyDimensionResult, Finding } from "../src/types";

const critical: Finding = {
  id: "SEC-DESTRUCTIVE-rm-rf",
  severity: "CRITICAL",
  category: "DESTRUCTIVE_COMMAND",
  dimension: "security",
  title: "Recursive force remove (rm -rf)",
  description: "test",
  location: "toolCall#0",
  evidence: "rm -rf /tmp/x",
  recommendation: "check it",
};

test("no security findings => gate success, overall PASS", () => {
  const card = buildScorecard({
    pr: 1,
    rubricVersion: 1,
    generatedAt: "2026-06-26T00:00:00Z",
    securityFindings: [],
  });
  expect(card.gate.check).toBe("eval/security");
  expect(card.gate.state).toBe("success");
  expect(card.overall).toBe("PASS");
});

test("a security finding => gate failure, overall FAIL", () => {
  const card = buildScorecard({
    pr: 1,
    sha: "abc123",
    rubricVersion: 1,
    generatedAt: "2026-06-26T00:00:00Z",
    securityFindings: [critical],
  });
  expect(card.gate.state).toBe("failure");
  expect(card.overall).toBe("FAIL");
  expect(card.dimensions[0].gating).toBe(true);
});

test("advisory dimensions never gate even when they WARN/FAIL", () => {
  const card = buildScorecard({
    pr: 1,
    rubricVersion: 1,
    generatedAt: "2026-06-26T00:00:00Z",
    securityFindings: [],
    advisory: [
      { dimension: "budget", verdict: "WARN", gating: true, findings: [] },
    ],
  });
  // security gate stays success; advisory is forced non-gating
  expect(card.gate.state).toBe("success");
  expect(card.dimensions[1].gating).toBe(false);
  // but overall still reflects the worst verdict
  expect(card.overall).toBe("WARN");
});

test("markdown renders verdict, gate, and findings", () => {
  const card = buildScorecard({
    pr: 42,
    sha: "deadbeefcafe",
    rubricVersion: 1,
    generatedAt: "2026-06-26T00:00:00Z",
    securityFindings: [critical],
  });
  const md = renderMarkdown(card);
  expect(md).toContain("Scorecard");
  expect(md).toContain("eval/security");
  expect(md).toContain("rm -rf");
  expect(md).toContain("FAIL");
});

const runnerEfficiency: EfficiencyDimensionResult = {
  dimension: "efficiency",
  verdict: "PASS",
  gating: false,
  advisory: true,
  role: "runner",
  findings: [],
  metrics: {
    inputTokens: 1234,
    outputTokens: 567,
    cacheReadTokens: 8900,
    toolCallCount: 12,
    wallClockMs: 95_000,
  },
};

const reviewerEfficiency: EfficiencyDimensionResult = {
  dimension: "efficiency",
  verdict: "PASS",
  gating: false,
  advisory: true,
  role: "reviewer",
  findings: [],
  metrics: {
    inputTokens: 500,
    outputTokens: 100,
    cacheReadTokens: 0,
    toolCallCount: 4,
    wallClockMs: undefined,
  },
};

test("efficiency dimensions included in scorecard dimensions", () => {
  const card = buildScorecard({
    pr: 10,
    rubricVersion: 1,
    generatedAt: "2026-07-01T00:00:00Z",
    securityFindings: [],
    advisory: [runnerEfficiency, reviewerEfficiency],
  });
  const effDims = card.dimensions.filter((d) => d.dimension === "efficiency");
  expect(effDims).toHaveLength(2);
  expect(effDims.every((d) => d.gating === false)).toBe(true);
});

test("efficiency dimensions never affect gate (always advisory)", () => {
  const card = buildScorecard({
    pr: 10,
    rubricVersion: 1,
    generatedAt: "2026-07-01T00:00:00Z",
    securityFindings: [],
    advisory: [runnerEfficiency],
  });
  expect(card.gate.state).toBe("success");
  expect(card.overall).toBe("PASS");
});

test("markdown renders per-role efficiency table", () => {
  const card = buildScorecard({
    pr: 10,
    rubricVersion: 1,
    generatedAt: "2026-07-01T00:00:00Z",
    securityFindings: [],
    advisory: [runnerEfficiency, reviewerEfficiency],
  });
  const md = renderMarkdown(card);
  expect(md).toContain("efficiency (advisory)");
  expect(md).toContain("runner");
  expect(md).toContain("reviewer");
  // token counts
  expect(md).toContain("1,234");
  expect(md).toContain("8,900");
  // wall-clock: 95000ms = 1m 35s
  expect(md).toContain("1m 35s");
  // reviewer has no wall-clock
  expect(md).toContain("—");
  // comparative note
  expect(md).toContain("Comparative only");
});
