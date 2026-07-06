import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendRun,
  runsForPr,
  latestRunForPr,
  latestRunForPrByRole,
  latestExistingRunForPrByRole,
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

// --- Existence-aware resolution (issue #38) ---
//
// The manifest can contain entries whose transcriptPath was never written to
// disk (a phantom SubagentStop path — 2026-07-06 incident). Resolution must
// walk back per role to the newest entry whose file exists, using real files
// on disk so the exists check is exercised for real, not just mocked.

function tmpDirFor(path: string): string {
  return join(dirname(path), "transcripts");
}

function realFile(dir: string, name: string): string {
  const p = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, "{}\n", "utf8");
  return p;
}

test("latestExistingRunForPrByRole — skips a newer entry whose file is missing, returns the older existing one", () => {
  const path = tmpManifest();
  const dir = tmpDirFor(path);
  const oldPath = realFile(dir, "old.jsonl");
  const phantomPath = join(dir, "phantom.jsonl"); // never written

  appendRun(mk(70, oldPath, "old-sha", "runner"), path);
  appendRun(mk(70, phantomPath, "new-sha", "runner"), path); // newest, phantom

  const entry = latestExistingRunForPrByRole(70, "runner", path);
  expect(entry).not.toBeNull();
  expect(entry!.transcriptPath).toBe(oldPath);
  expect(entry!.sha).toBe("old-sha");
});

test("latestExistingRunForPrByRole — returns null when the role has zero entries at all (not just missing files)", () => {
  const path = tmpManifest();
  const dir = tmpDirFor(path);
  const reviewerOnly = realFile(dir, "reviewer.jsonl");
  appendRun(mk(75, reviewerOnly, "v1", "reviewer"), path);

  expect(latestExistingRunForPrByRole(75, "runner", path)).toBeNull();
});

test("latestExistingRunForPrByRole — returns null when no entry for the role has an existing file", () => {
  const path = tmpManifest();
  const dir = tmpDirFor(path);
  appendRun(mk(71, join(dir, "phantom-a.jsonl"), "a", "runner"), path);
  appendRun(mk(71, join(dir, "phantom-b.jsonl"), "b", "runner"), path);

  expect(latestExistingRunForPrByRole(71, "runner", path)).toBeNull();
});

test("latestExistingRunForPrByRole — resolves runner and reviewer independently, each skipping their own phantoms", () => {
  const path = tmpManifest();
  const dir = tmpDirFor(path);
  const runnerOld = realFile(dir, "runner-old.jsonl");
  const reviewerReal = realFile(dir, "reviewer.jsonl");

  appendRun(mk(72, runnerOld, "r-old", "runner"), path);
  appendRun(mk(72, join(dir, "runner-phantom.jsonl"), "r-new", "runner"), path);
  appendRun(mk(72, reviewerReal, "v1", "reviewer"), path);

  expect(latestExistingRunForPrByRole(72, "runner", path)!.transcriptPath).toBe(runnerOld);
  expect(latestExistingRunForPrByRole(72, "reviewer", path)!.transcriptPath).toBe(reviewerReal);
});

test("latestExistingRunForPrByRole — missing manifest yields null (no throw)", () => {
  expect(latestExistingRunForPrByRole(1, "runner", "/nonexistent/manifest.jsonl")).toBeNull();
});

test("latestExistingRunForPrByRole — walks back past multiple consecutive phantom entries", () => {
  const path = tmpManifest();
  const dir = tmpDirFor(path);
  const oldPath = realFile(dir, "old.jsonl");

  appendRun(mk(73, oldPath, "old-sha", "runner"), path);
  appendRun(mk(73, join(dir, "phantom-1.jsonl"), "p1", "runner"), path);
  appendRun(mk(73, join(dir, "phantom-2.jsonl"), "p2", "runner"), path);
  appendRun(mk(73, join(dir, "phantom-3.jsonl"), "p3", "runner"), path); // newest, phantom

  const entry = latestExistingRunForPrByRole(73, "runner", path);
  expect(entry).not.toBeNull();
  expect(entry!.transcriptPath).toBe(oldPath);
  expect(entry!.sha).toBe("old-sha");
});

test("latestExistingRunForPrByRole — injectable exists fn is used instead of real fs (no disk I/O)", () => {
  const path = tmpManifest();
  // Paths are never written to disk; the injected `exists` fn is the sole source of truth.
  appendRun(mk(74, "/virtual/old.jsonl", "old-sha", "runner"), path);
  appendRun(mk(74, "/virtual/new.jsonl", "new-sha", "runner"), path);

  const exists = (p: string) => p === "/virtual/old.jsonl";
  const entry = latestExistingRunForPrByRole(74, "runner", path, exists);
  expect(entry).not.toBeNull();
  expect(entry!.sha).toBe("old-sha");

  // Sanity: with a predicate that always reports true, the newest entry wins as usual.
  const entryAlwaysExists = latestExistingRunForPrByRole(74, "runner", path, () => true);
  expect(entryAlwaysExists!.sha).toBe("new-sha");

  // Sanity: with a predicate that always reports false, resolution yields null.
  expect(latestExistingRunForPrByRole(74, "runner", path, () => false)).toBeNull();
});
