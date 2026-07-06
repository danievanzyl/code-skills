import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickTranscriptPath, type HookPayload } from "../scripts/capture-run";

// --- SubagentStop/Stop transcript-path selection (issue #34, hardened #37) ---
// Issue #37: capture-run must verify a transcript exists on disk before
// linking it — the CLI can advertise `agent_transcript_path` for a subagent
// whose transcript was never written, and blindly trusting it poisons the
// manifest (2026-07-06 incident).

function tmpFile(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, "{}\n", "utf8");
  return p;
}

test("SubagentStop payload with an existing agent_transcript_path links it, not the parent's", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-eval-capture-"));
  const agentPath = tmpFile(dir, "agent-abc123.jsonl");
  const parentPath = tmpFile(dir, "session.jsonl");
  const payload: HookPayload = {
    hook_event_name: "SubagentStop",
    transcript_path: parentPath,
    agent_transcript_path: agentPath,
  };
  expect(pickTranscriptPath(payload)).toBe(agentPath);
});

test("agent_transcript_path does not exist on disk but transcript_path does → falls back to transcript_path", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-eval-capture-"));
  const parentPath = tmpFile(dir, "session.jsonl");
  const phantomAgentPath = join(dir, "subagents", "agent-abc123.jsonl"); // never written
  const payload: HookPayload = {
    hook_event_name: "SubagentStop",
    transcript_path: parentPath,
    agent_transcript_path: phantomAgentPath,
  };
  expect(existsSync(phantomAgentPath)).toBe(false);
  expect(pickTranscriptPath(payload)).toBe(parentPath);
});

test("neither transcript path exists on disk → undefined (caller skips, no manifest entry)", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-eval-capture-"));
  const payload: HookPayload = {
    hook_event_name: "SubagentStop",
    transcript_path: join(dir, "session.jsonl"),
    agent_transcript_path: join(dir, "subagents", "agent-abc123.jsonl"),
  };
  expect(pickTranscriptPath(payload)).toBeUndefined();
});

test("Stop payload with only an existing transcript_path links it", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-eval-capture-"));
  const parentPath = tmpFile(dir, "session.jsonl");
  const payload: HookPayload = {
    hook_event_name: "Stop",
    transcript_path: parentPath,
  };
  expect(pickTranscriptPath(payload)).toBe(parentPath);
});

test("payload with neither field yields undefined (caller skips)", () => {
  const payload: HookPayload = {
    hook_event_name: "SubagentStop",
  };
  expect(pickTranscriptPath(payload)).toBeUndefined();
});

test("empty-string agent_transcript_path is not an existing file, so an existing transcript_path wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-eval-capture-"));
  const parentPath = tmpFile(dir, "session.jsonl");
  const payload: HookPayload = {
    hook_event_name: "SubagentStop",
    transcript_path: parentPath,
    agent_transcript_path: "",
  };
  expect(pickTranscriptPath(payload)).toBe(parentPath);
});

// --- End-to-end: guard against a silently no-op hook (issue #34 highest risk) ---
//
// `main()` only runs under `if (import.meta.main)` so tests can import the
// module without side effects. That guard must still be true when the hook
// wrapper invokes this file via `bun run capture-run.ts` — otherwise the hook
// silently does nothing, exactly the failure class #34 exists to fix. Run the
// real script as a subprocess (as hooks/capture-run.sh does) to prove it.

interface CaptureResult {
  out: string;
  err: string;
  code: number;
}

function runCapture(payload: unknown, stateDir: string): Promise<CaptureResult> {
  const scriptPath = join(import.meta.dir, "../scripts/capture-run.ts");
  const proc = Bun.spawn(["bun", "run", scriptPath], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RUN_EVAL_STATE_DIR: stateDir },
  });
  return Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([out, err, code]) => ({ out, err, code }));
}

test("end-to-end: main() runs via `bun run`, skipping on a neither-field payload with no manifest write", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "run-eval-capture-"));
  const { err, code } = await runCapture({ hook_event_name: "SubagentStop" }, stateDir);
  // Reaching the "no transcript_path" skip message proves main() executed —
  // if the import.meta.main guard were false here, there would be no output
  // at all (bun would just load the module and exit without running main()).
  expect(err).toContain("no transcript_path in payload; skipping");
  expect(code).toBe(0);
  expect(existsSync(join(stateDir, "manifest.jsonl"))).toBe(false);
});

// --- Regression: 2026-07-06 incident (issue #37) ---
//
// Claude Code CLI fired SubagentStop for internal harness agents whose
// advertised `agent_transcript_path` was never written to disk. capture-run
// linked the phantom path into the manifest, poisoning it. It must instead
// fall back to `transcript_path` when that exists on disk, and write nothing
// when neither path exists — always exiting 0 (audit-only, never blocking).

test("regression: phantom agent_transcript_path falls back to the real transcript_path, no phantom entry", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "run-eval-capture-"));
  const realParentPath = tmpFile(stateDir, "session.jsonl");
  const phantomAgentPath = join(stateDir, "subagents", "agent-phantom.jsonl"); // never written
  const { err, code } = await runCapture(
    {
      hook_event_name: "SubagentStop",
      transcript_path: realParentPath,
      agent_transcript_path: phantomAgentPath,
    },
    stateDir,
  );
  expect(code).toBe(0);
  // No `gh pr view` in this sandbox → still skips before appendRun, but must
  // never reference the phantom path as the chosen transcript.
  expect(err).not.toContain(phantomAgentPath);
});

test("regression: neither transcript path exists on disk → health line logged, no manifest entry, exit 0", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "run-eval-capture-"));
  const { err, code } = await runCapture(
    {
      hook_event_name: "SubagentStop",
      transcript_path: join(stateDir, "session.jsonl"),
      agent_transcript_path: join(stateDir, "subagents", "agent-phantom.jsonl"),
    },
    stateDir,
  );
  expect(code).toBe(0);
  expect(err).toContain("skipping");
  expect(existsSync(join(stateDir, "manifest.jsonl"))).toBe(false);
});
