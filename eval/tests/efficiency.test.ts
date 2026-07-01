import { test, expect } from "bun:test";
import { parseTrajectory } from "../src/trajectory/parser";
import { scoreEfficiency } from "../src/scorers/efficiency";

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
