import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRun, type RunEntry, type AgentRole } from "../src/manifest";
import type { Scorecard } from "../src/types";

// --- eval-pr.ts manifest resolution, end-to-end (issue #38) ---
//
// A missing transcript file must never crash eval-pr with a raw ENOENT stack
// trace. Resolution must walk back per role to the newest entry whose file
// still exists on disk; when no runner entry qualifies, it must exit cleanly;
// when only the reviewer entry is missing, the eval must proceed runner-only.

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "run-eval-pr-"));
}

function tmpManifest(dir: string): string {
  return join(dir, "manifest.jsonl");
}

/** A transcript file that actually exists on disk and parses cleanly. */
function writeTranscript(dir: string, name: string, sessionId: string): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    JSON.stringify({
      type: "assistant",
      sessionId,
      message: { role: "assistant", usage: {}, content: [{ type: "text", text: "hi" }] },
    }) + "\n",
    "utf8",
  );
  return p;
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

interface EvalPrResult {
  out: string;
  err: string;
  code: number;
}

function runEvalPr(args: string[]): Promise<EvalPrResult> {
  const scriptPath = join(import.meta.dir, "../scripts/eval-pr.ts");
  const proc = Bun.spawn(["bun", "run", scriptPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([out, err, code]) => ({ out, err, code }));
}

/** The script writes `renderMarkdown(card)` then `JSON.stringify(card, null, 2)`. */
function extractScorecard(stdout: string): Scorecard {
  const idx = stdout.lastIndexOf("\n{\n");
  expect(idx).toBeGreaterThan(-1);
  return JSON.parse(stdout.slice(idx + 1)) as Scorecard;
}

test("regression: newest runner entry's transcript missing, older entry's exists → eval succeeds using the older entry", async () => {
  const dir = tmpDir();
  const manifest = tmpManifest(dir);
  const oldPath = writeTranscript(dir, "old-stop.jsonl", "sess-old");
  const phantomPath = join(dir, "subagents", "agent-phantom.jsonl"); // never written

  appendRun(mk(101, oldPath, "old-sha", "runner"), manifest);
  appendRun(mk(101, phantomPath, "new-sha", "runner"), manifest); // newest, phantom

  const { out, err, code } = await runEvalPr(["--pr", "101", "--manifest", manifest]);

  expect(code).toBe(0);
  expect(err).not.toContain("ENOENT");
  expect(err).not.toContain("    at ");
  const card = extractScorecard(out);
  expect(card.sha).toBe("old-sha");
});

test("no runner entry has an existing transcript → clean one-line error, exit 2, no stack trace", async () => {
  const dir = tmpDir();
  const manifest = tmpManifest(dir);
  const phantomA = join(dir, "phantom-a.jsonl");
  const phantomB = join(dir, "phantom-b.jsonl");

  appendRun(mk(202, phantomA, "a", "runner"), manifest);
  appendRun(mk(202, phantomB, "b", "runner"), manifest);

  const { err, code } = await runEvalPr(["--pr", "202", "--manifest", manifest]);

  expect(code).toBe(2);
  const lines = err.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("error:");
  expect(lines[0]).not.toContain("ENOENT");
  expect(err).not.toContain("    at ");
});

test("reviewer entry's transcript missing → proceeds runner-only, advisory reviewer dimension absent", async () => {
  const dir = tmpDir();
  const manifest = tmpManifest(dir);
  const runnerPath = writeTranscript(dir, "runner.jsonl", "sess-runner");
  const phantomReviewerPath = join(dir, "reviewer-phantom.jsonl"); // never written

  appendRun(mk(303, runnerPath, "r-sha", "runner"), manifest);
  appendRun(mk(303, phantomReviewerPath, "v-sha", "reviewer"), manifest);

  const { out, err, code } = await runEvalPr(["--pr", "303", "--manifest", manifest]);

  expect(code).toBe(0);
  expect(err).toContain("proceeding runner-only");
  expect(err).not.toContain("ENOENT");
  const card = extractScorecard(out);
  const efficiencyDims = card.dimensions.filter((d) => d.dimension === "efficiency");
  expect(efficiencyDims).toHaveLength(1);
});

test("no reviewer entry at all (not phantom, simply absent) → runner-only, no spurious 'proceeding runner-only' note", async () => {
  const dir = tmpDir();
  const manifest = tmpManifest(dir);
  const runnerPath = writeTranscript(dir, "runner.jsonl", "sess-runner");

  appendRun(mk(304, runnerPath, "r-sha", "runner"), manifest);

  const { out, err, code } = await runEvalPr(["--pr", "304", "--manifest", manifest]);

  expect(code).toBe(0);
  expect(err).not.toContain("proceeding runner-only");
  const card = extractScorecard(out);
  const efficiencyDims = card.dimensions.filter((d) => d.dimension === "efficiency");
  expect(efficiencyDims).toHaveLength(1);
});

test("explicit --transcript bypasses manifest resolution even when the newest manifest entry is phantom", async () => {
  const dir = tmpDir();
  const manifest = tmpManifest(dir);
  const explicitPath = writeTranscript(dir, "explicit.jsonl", "sess-explicit");
  const phantomPath = join(dir, "phantom.jsonl"); // never written, would otherwise error

  appendRun(mk(305, phantomPath, "phantom-sha", "runner"), manifest);

  const { out, err, code } = await runEvalPr([
    "--pr",
    "305",
    "--manifest",
    manifest,
    "--transcript",
    explicitPath,
  ]);

  expect(code).toBe(0);
  expect(err).not.toContain("ENOENT");
  const card = extractScorecard(out);
  // --transcript carries no sha/runId of its own and the manifest lookup is
  // skipped entirely, so the card's sha must be absent — never leaked from
  // the phantom manifest entry.
  expect(card.sha).toBeUndefined();
});

test("explicit --reviewer-transcript bypasses manifest resolution even when the newest reviewer entry is phantom", async () => {
  const dir = tmpDir();
  const manifest = tmpManifest(dir);
  const runnerPath = writeTranscript(dir, "runner.jsonl", "sess-runner");
  const explicitReviewerPath = writeTranscript(dir, "reviewer-explicit.jsonl", "sess-reviewer");
  const phantomReviewerPath = join(dir, "reviewer-phantom.jsonl"); // never written

  appendRun(mk(306, runnerPath, "r-sha", "runner"), manifest);
  appendRun(mk(306, phantomReviewerPath, "v-sha", "reviewer"), manifest);

  const { out, err, code } = await runEvalPr([
    "--pr",
    "306",
    "--manifest",
    manifest,
    "--reviewer-transcript",
    explicitReviewerPath,
  ]);

  expect(code).toBe(0);
  expect(err).not.toContain("proceeding runner-only");
  expect(err).not.toContain("ENOENT");
  const card = extractScorecard(out);
  const efficiencyDims = card.dimensions.filter((d) => d.dimension === "efficiency");
  expect(efficiencyDims).toHaveLength(2);
});
