import { test, expect } from "bun:test";
import { parseTrajectory } from "../src/trajectory/parser";
import { scoreEfficiency } from "../src/scorers/efficiency";
import { buildScorecard, renderMarkdown } from "../src/scorecard/build";

// --- Parser extraction tests ---

test("parser extracts cache-read tokens from usage block", () => {
  const jsonl = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 500,
      },
      content: [],
    },
  });
  const traj = parseTrajectory(jsonl);
  expect(traj.usage.inputTokens).toBe(100);
  expect(traj.usage.outputTokens).toBe(20);
  expect(traj.usage.cacheReadTokens).toBe(500);
});

test("parser sums cache-read tokens across multiple lines", () => {
  const lines = [
    JSON.stringify({
      type: "assistant",
      message: {
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 200 },
        content: [],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 300 },
        content: [],
      },
    }),
  ];
  const traj = parseTrajectory(lines.join("\n"));
  expect(traj.usage.cacheReadTokens).toBe(500);
});

test("parser yields zero cacheReadTokens when field absent", () => {
  const jsonl = JSON.stringify({
    type: "assistant",
    message: {
      usage: { input_tokens: 80, output_tokens: 15 },
      content: [],
    },
  });
  const traj = parseTrajectory(jsonl);
  expect(traj.usage.cacheReadTokens).toBe(0);
});

test("parser extracts first and last timestamps from top-level ts field", () => {
  const lines = [
    JSON.stringify({ type: "assistant", ts: "2026-01-01T10:00:00.000Z", message: { content: [] } }),
    JSON.stringify({ type: "assistant", ts: "2026-01-01T10:00:05.000Z", message: { content: [] } }),
    JSON.stringify({ type: "assistant", ts: "2026-01-01T10:00:15.000Z", message: { content: [] } }),
  ];
  const traj = parseTrajectory(lines.join("\n"));
  expect(traj.firstTimestamp).toBe("2026-01-01T10:00:00.000Z");
  expect(traj.lastTimestamp).toBe("2026-01-01T10:00:15.000Z");
});

test("parser handles missing timestamps gracefully", () => {
  const jsonl = JSON.stringify({
    type: "assistant",
    message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
  });
  const traj = parseTrajectory(jsonl);
  expect(traj.firstTimestamp).toBeUndefined();
  expect(traj.lastTimestamp).toBeUndefined();
});

test("parser picks up timestamp field as fallback to ts", () => {
  const lines = [
    JSON.stringify({ type: "assistant", timestamp: "2026-06-01T08:00:00.000Z", message: { content: [] } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-06-01T08:01:00.000Z", message: { content: [] } }),
  ];
  const traj = parseTrajectory(lines.join("\n"));
  expect(traj.firstTimestamp).toBe("2026-06-01T08:00:00.000Z");
  expect(traj.lastTimestamp).toBe("2026-06-01T08:01:00.000Z");
});

// --- Efficiency scorer tests ---

test("scoreEfficiency produces advisory=true, never gating", () => {
  const traj = parseTrajectory(
    JSON.stringify({
      type: "assistant",
      ts: "2026-01-01T10:00:00.000Z",
      message: {
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 400 },
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
      },
    }),
  );
  const result = scoreEfficiency({ role: "runner", trajectory: traj });
  expect(result.dimension).toBe("efficiency");
  expect(result.gating).toBe(false);
  expect(result.advisory).toBe(true);
});

test("scoreEfficiency captures all metrics in metrics field", () => {
  const lines = [
    JSON.stringify({
      type: "assistant",
      ts: "2026-01-01T10:00:00.000Z",
      message: {
        usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 600 },
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      ts: "2026-01-01T10:00:30.000Z",
      message: {
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
        content: [{ type: "tool_use", id: "t3", name: "Edit", input: {} }],
      },
    }),
  ];
  const traj = parseTrajectory(lines.join("\n"));
  const result = scoreEfficiency({ role: "runner", trajectory: traj });

  expect(result.metrics.inputTokens).toBe(300);
  expect(result.metrics.outputTokens).toBe(60);
  expect(result.metrics.cacheReadTokens).toBe(600);
  expect(result.metrics.toolCallCount).toBe(3);
  expect(result.metrics.wallClockMs).toBe(30000);
});

test("scoreEfficiency wallClockMs is undefined when timestamps absent", () => {
  const traj = parseTrajectory(
    JSON.stringify({
      type: "assistant",
      message: {
        usage: { input_tokens: 50, output_tokens: 10 },
        content: [],
      },
    }),
  );
  const result = scoreEfficiency({ role: "reviewer", trajectory: traj });
  expect(result.metrics.wallClockMs).toBeUndefined();
});

test("scoreEfficiency verdict is always PASS (advisory, no thresholds in v1)", () => {
  const traj = parseTrajectory(
    JSON.stringify({
      type: "assistant",
      message: {
        usage: { input_tokens: 999999, output_tokens: 99999 },
        content: [],
      },
    }),
  );
  const result = scoreEfficiency({ role: "runner", trajectory: traj });
  expect(result.verdict).toBe("PASS");
});

test("scoreEfficiency carries role field", () => {
  const traj = parseTrajectory(
    JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 10, output_tokens: 2 }, content: [] },
    }),
  );
  const runnerResult = scoreEfficiency({ role: "runner", trajectory: traj });
  const reviewerResult = scoreEfficiency({ role: "reviewer", trajectory: traj });
  expect(runnerResult.role).toBe("runner");
  expect(reviewerResult.role).toBe("reviewer");
});

test("scoreEfficiency finds field is empty (no threshold-based findings in v1)", () => {
  const traj = parseTrajectory(
    JSON.stringify({
      type: "assistant",
      message: {
        usage: { input_tokens: 5000, output_tokens: 1000 },
        content: [],
      },
    }),
  );
  const result = scoreEfficiency({ role: "runner", trajectory: traj });
  expect(result.findings).toHaveLength(0);
});

// --- Edge case tests ---

test("single-message transcript: wallClockMs is 0 (same first and last timestamp)", () => {
  // When only one timestamp exists, first === last, so duration is 0 (not undefined).
  // A single timestamp IS present, so wall-clock is derivable — it just happens to be 0.
  const traj = parseTrajectory(
    JSON.stringify({
      type: "assistant",
      ts: "2026-01-01T10:00:00.000Z",
      message: { usage: { input_tokens: 10, output_tokens: 2 }, content: [] },
    }),
  );
  expect(traj.firstTimestamp).toBe("2026-01-01T10:00:00.000Z");
  expect(traj.lastTimestamp).toBe("2026-01-01T10:00:00.000Z");
  const result = scoreEfficiency({ role: "runner", trajectory: traj });
  expect(result.metrics.wallClockMs).toBe(0);
});

test("reversed timestamps clamp to 0 (Math.max guard, not undefined)", () => {
  // If lines arrive with a decreasing timestamp sequence, lastTimestamp < firstTimestamp.
  // The scorer clamps to 0 rather than returning a negative duration.
  const lines = [
    JSON.stringify({ type: "assistant", ts: "2026-01-01T10:00:30.000Z", message: { content: [] } }),
    JSON.stringify({ type: "assistant", ts: "2026-01-01T10:00:00.000Z", message: { content: [] } }),
  ];
  const traj = parseTrajectory(lines.join("\n"));
  // Parser records first-seen as firstTimestamp, last-seen as lastTimestamp.
  expect(traj.firstTimestamp).toBe("2026-01-01T10:00:30.000Z");
  expect(traj.lastTimestamp).toBe("2026-01-01T10:00:00.000Z");
  const result = scoreEfficiency({ role: "runner", trajectory: traj });
  // Must be 0 (clamped), never negative.
  expect(result.metrics.wallClockMs).toBe(0);
  expect(result.metrics.wallClockMs).toBeGreaterThanOrEqual(0);
});

test("ts field takes priority over timestamp field on same line", () => {
  // When a line carries both ts and timestamp, ts wins.
  const line = JSON.stringify({
    type: "assistant",
    ts: "2026-01-01T12:00:00.000Z",
    timestamp: "2026-01-01T09:00:00.000Z",
    message: { content: [] },
  });
  const traj = parseTrajectory(line);
  expect(traj.firstTimestamp).toBe("2026-01-01T12:00:00.000Z");
});

test("parser handles empty jsonl string without throwing", () => {
  const traj = parseTrajectory("");
  expect(traj.toolCalls).toHaveLength(0);
  expect(traj.usage.cacheReadTokens).toBe(0);
  expect(traj.firstTimestamp).toBeUndefined();
  expect(traj.lastTimestamp).toBeUndefined();
});

test("parser handles malformed cache_read_input_tokens (NaN coerces to 0)", () => {
  const jsonl = JSON.stringify({
    type: "assistant",
    message: {
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: "bad" },
      content: [],
    },
  });
  const traj = parseTrajectory(jsonl);
  // "bad" coerces to NaN; the || 0 guard must yield 0.
  expect(traj.usage.cacheReadTokens).toBe(0);
});

test("metrics field is preserved verbatim after buildScorecard spread", () => {
  // Regression guard: buildScorecard spreads advisory dims — verify metrics survive.
  const traj = parseTrajectory(
    JSON.stringify({
      type: "assistant",
      ts: "2026-01-01T10:00:00.000Z",
      message: {
        usage: { input_tokens: 42, output_tokens: 7, cache_read_input_tokens: 99 },
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
    }),
  );
  const effDim = scoreEfficiency({ role: "runner", trajectory: traj });
  const card = buildScorecard({
    pr: 1,
    rubricVersion: 1,
    generatedAt: "2026-07-01T00:00:00Z",
    securityFindings: [],
    advisory: [effDim],
  });
  const persisted = card.dimensions.find((d) => d.dimension === "efficiency") as typeof effDim;
  expect(persisted).toBeDefined();
  expect(persisted.metrics.inputTokens).toBe(42);
  expect(persisted.metrics.outputTokens).toBe(7);
  expect(persisted.metrics.cacheReadTokens).toBe(99);
  expect(persisted.metrics.toolCallCount).toBe(1);
  expect(persisted.gating).toBe(false);
});

test("efficiency rows do not appear as findings rows in markdown", () => {
  // The findings loop must skip efficiency dims — they must not produce a findings section.
  const traj = parseTrajectory(
    JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
    }),
  );
  const effDim = scoreEfficiency({ role: "runner", trajectory: traj });
  const card = buildScorecard({
    pr: 1,
    rubricVersion: 1,
    generatedAt: "2026-07-01T00:00:00Z",
    securityFindings: [],
    advisory: [effDim],
  });
  const md = renderMarkdown(card);
  // Efficiency must appear as the grouped table, NOT as a "### efficiency (advisory)" dim section
  // with "_No findings._" — it should appear exactly once under the table heading.
  const occurrences = (md.match(/efficiency \(advisory\)/g) ?? []).length;
  expect(occurrences).toBe(1);
  // The table header must be present.
  expect(md).toContain("| role | input tokens |");
  // No "No findings." for efficiency — it has no findings section.
  const lines = md.split("\n");
  const effIdx = lines.findIndex((l) => l.includes("efficiency (advisory)"));
  // The line after the heading should be the comparative note, not "_No findings._"
  expect(lines[effIdx + 1]).not.toBe("_No findings._");
});
