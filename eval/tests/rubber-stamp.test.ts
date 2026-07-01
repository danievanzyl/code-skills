import { test, expect } from "bun:test";
import { parseTrajectory } from "../src/trajectory/parser";
import { scoreRubberStamp } from "../src/scorers/rubber-stamp";
import { loadRubric } from "../src/rubric/loader";

const rubric = loadRubric();

// --- Helper to build a trajectory JSONL line with tool calls ---
function makeToolLine(toolCalls: Array<{ name: string; input?: Record<string, unknown> }>) {
  return JSON.stringify({
    type: "assistant",
    message: {
      usage: { input_tokens: 100, output_tokens: 20 },
      content: toolCalls.map((tc, i) => ({
        type: "tool_use",
        id: `t${i}`,
        name: tc.name,
        input: tc.input ?? {},
      })),
    },
  });
}

// 1. Rubber-stamp: no reads, no tests => advisory WARN
test("rubber-stamp: no read tool and no test run => WARN", () => {
  const traj = parseTrajectory(
    makeToolLine([
      { name: "Bash", input: { command: "git status" } },
      { name: "Edit", input: { file_path: "src/foo.ts" } },
    ]),
  );
  const result = scoreRubberStamp({ trajectory: traj }, rubric);
  expect(result.verdict).toBe("WARN");
  expect(result.gating).toBe(false);
  expect(result.dimension).toBe("process");
  expect(result.role).toBe("reviewer");
  expect(result.findings.length).toBeGreaterThan(0);
  const f = result.findings[0];
  expect(f.severity).toBe("MEDIUM");
  expect(f.id).toContain("RUBBER-STAMP");
  expect(f.dimension).toBe("process");
});

// 2. Rubber-stamp: has reads but no tests => WARN
test("rubber-stamp: read tool present but no test run => WARN", () => {
  const traj = parseTrajectory(
    makeToolLine([
      { name: "Read", input: { file_path: "src/foo.ts" } },
      { name: "Edit", input: { file_path: "src/foo.ts" } },
    ]),
  );
  const result = scoreRubberStamp({ trajectory: traj }, rubric);
  expect(result.verdict).toBe("WARN");
  expect(result.findings.some((f) => f.id.includes("NO-TEST-RUN"))).toBe(true);
});

// 3. Rubber-stamp: has tests but no reads => WARN
test("rubber-stamp: test run present but no read tool => WARN", () => {
  const traj = parseTrajectory(
    makeToolLine([
      { name: "Bash", input: { command: "bun test" } },
      { name: "Edit", input: { file_path: "src/foo.ts" } },
    ]),
  );
  const result = scoreRubberStamp({ trajectory: traj }, rubric);
  expect(result.verdict).toBe("WARN");
  expect(result.findings.some((f) => f.id.includes("NO-READ-TOOL"))).toBe(true);
});

// 4. Genuine review: reads + tests => PASS
test("genuine review: read tool AND test run => PASS", () => {
  const lines = [
    makeToolLine([
      { name: "Read", input: { file_path: "src/foo.ts" } },
    ]),
    makeToolLine([
      { name: "Bash", input: { command: "bun test" } },
    ]),
  ].join("\n");
  const traj = parseTrajectory(lines);
  const result = scoreRubberStamp({ trajectory: traj }, rubric);
  expect(result.verdict).toBe("PASS");
  expect(result.findings).toHaveLength(0);
});

// 5. Nothing-to-fix: reads + tests, 0 commits => PASS (commit count NOT a signal)
test("nothing-to-fix: reads+tests, 0 git commits => PASS (commit count not a signal)", () => {
  const lines = [
    makeToolLine([
      { name: "Grep", input: { pattern: "foo", path: "." } },
      { name: "Bash", input: { command: "bun test" } },
    ]),
  ].join("\n");
  const traj = parseTrajectory(lines);
  // 0 git commits — purely determined by trajectory signals, not commit count
  const result = scoreRubberStamp({ trajectory: traj }, rubric);
  expect(result.verdict).toBe("PASS");
  expect(result.findings).toHaveLength(0);
});

// 6. Glob counts as a read tool
test("Glob counts as a read tool", () => {
  const lines = [
    makeToolLine([
      { name: "Glob", input: { pattern: "**/*.ts" } },
      { name: "Bash", input: { command: "npm test" } },
    ]),
  ].join("\n");
  const traj = parseTrajectory(lines);
  const result = scoreRubberStamp({ trajectory: traj }, rubric);
  expect(result.verdict).toBe("PASS");
});

// 7. Test patterns: npm run test, pytest, go test all count
test("various test runners are recognised", () => {
  const runners = [
    "npm run test",
    "npm test",
    "yarn test",
    "pytest tests/",
    "go test ./...",
    "cargo test",
    "make test",
  ];
  for (const cmd of runners) {
    const traj = parseTrajectory(
      makeToolLine([
        { name: "Read", input: { file_path: "README.md" } },
        { name: "Bash", input: { command: cmd } },
      ]),
    );
    const result = scoreRubberStamp({ trajectory: traj }, rubric);
    expect(result.verdict).toBe("PASS");
  }
});

// 8. Finding is attributed role=reviewer
test("finding is attributed to role=reviewer", () => {
  const traj = parseTrajectory(makeToolLine([])); // empty trajectory
  const result = scoreRubberStamp({ trajectory: traj }, rubric);
  expect(result.role).toBe("reviewer");
  // All findings should be process dimension
  for (const f of result.findings) {
    expect(f.dimension).toBe("process");
  }
});

// 9. Advisory — never gating
test("rubber-stamp result is never gating", () => {
  const traj = parseTrajectory(makeToolLine([]));
  const result = scoreRubberStamp({ trajectory: traj }, rubric);
  expect(result.gating).toBe(false);
});

// 10. Empty trajectory => WARN (no evidence of anything)
test("empty trajectory => WARN", () => {
  const traj = parseTrajectory("");
  const result = scoreRubberStamp({ trajectory: traj }, rubric);
  expect(result.verdict).toBe("WARN");
});
