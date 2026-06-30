import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRun,
  runsForPr,
  latestRunForPr,
  type RunEntry,
} from "../src/manifest";

function tmpManifest(): string {
  return join(mkdtempSync(join(tmpdir(), "run-eval-")), "manifest.jsonl");
}

const mk = (pr: number, path: string, sha: string): RunEntry => ({
  pr,
  transcriptPath: path,
  sha,
  runId: `run-${sha}`,
  event: "SubagentStop",
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
