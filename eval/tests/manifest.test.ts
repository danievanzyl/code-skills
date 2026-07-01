import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRun,
  runsForPr,
  latestRunForPr,
  latestRunForPrByRole,
  type RunEntry,
  type AgentRole,
} from "../src/manifest";

function tmpManifest(): string {
  return join(mkdtempSync(join(tmpdir(), "run-eval-")), "manifest.jsonl");
}

const mk = (pr: number, path: string, sha: string, role?: AgentRole): RunEntry => ({
  pr,
  transcriptPath: path,
  sha,
  runId: `run-${sha}`,
  event: "SubagentStop",
  role,
  ts: new Date().toISOString(),
});

test("append + read back entries for a PR", () => {
  const path = tmpManifest();
  appendRun(mk(10, "/t/a.jsonl", "aaa"), path);
  appendRun(mk(11, "/t/b.jsonl", "bbb"), path);
  appendRun(mk(10, "/t/c.jsonl", "ccc"), path);

  expect(runsForPr(10, path)).toHaveLength(2);
  expect(runsForPr(11, path)).toHaveLength(1);
  expect(runsForPr(999, path)).toHaveLength(0);
});

test("latestRunForPr returns last write (re-run / re-review)", () => {
  const path = tmpManifest();
  appendRun(mk(10, "/t/old.jsonl", "old"), path);
  appendRun(mk(10, "/t/new.jsonl", "new"), path);
  expect(latestRunForPr(10, path)!.transcriptPath).toBe("/t/new.jsonl");
});

test("missing manifest yields no entries (no throw)", () => {
  expect(runsForPr(1, "/nonexistent/manifest.jsonl")).toEqual([]);
  expect(latestRunForPr(1, "/nonexistent/manifest.jsonl")).toBeNull();
});

// --- Role-tagged both-agent capture (issue #22) ---

test("absent role is treated as runner (back-compat)", () => {
  const path = tmpManifest();
  // entry written without a role field (legacy capture hook)
  appendRun(mk(20, "/t/legacy.jsonl", "leg"), path);
  const entry = latestRunForPrByRole(20, "runner", path);
  expect(entry).not.toBeNull();
  expect(entry!.transcriptPath).toBe("/t/legacy.jsonl");
});

test("latestRunForPrByRole — runner+reviewer fixture resolves each independently", () => {
  const path = tmpManifest();
  appendRun(mk(30, "/t/runner.jsonl", "r1", "runner"), path);
  appendRun(mk(30, "/t/reviewer.jsonl", "v1", "reviewer"), path);

  const runner = latestRunForPrByRole(30, "runner", path);
  const reviewer = latestRunForPrByRole(30, "reviewer", path);

  expect(runner).not.toBeNull();
  expect(reviewer).not.toBeNull();
  expect(runner!.transcriptPath).toBe("/t/runner.jsonl");
  expect(reviewer!.transcriptPath).toBe("/t/reviewer.jsonl");
});

test("latestRunForPrByRole — last write wins per role", () => {
  const path = tmpManifest();
  appendRun(mk(40, "/t/r-old.jsonl", "r1", "runner"), path);
  appendRun(mk(40, "/t/rev.jsonl", "v1", "reviewer"), path);
  appendRun(mk(40, "/t/r-new.jsonl", "r2", "runner"), path);

  expect(latestRunForPrByRole(40, "runner", path)!.transcriptPath).toBe("/t/r-new.jsonl");
  expect(latestRunForPrByRole(40, "reviewer", path)!.transcriptPath).toBe("/t/rev.jsonl");
});

test("latestRunForPrByRole returns null when no entry exists for that role", () => {
  const path = tmpManifest();
  appendRun(mk(50, "/t/runner.jsonl", "r1", "runner"), path);
  expect(latestRunForPrByRole(50, "reviewer", path)).toBeNull();
});

test("latestRunForPrByRole — legacy entries (no role field) do not match reviewer query", () => {
  const path = tmpManifest();
  // Write entry without a role field (simulates pre-#22 capture hook output).
  // Absent role = runner; reviewer query must return null, not the legacy entry.
  appendRun(mk(60, "/t/legacy.jsonl", "leg"), path);
  expect(latestRunForPrByRole(60, "reviewer", path)).toBeNull();
});
