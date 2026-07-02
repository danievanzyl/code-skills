import { test, expect } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickTranscriptPath, type HookPayload } from "../scripts/capture-run";

// --- SubagentStop/Stop transcript-path selection (issue #34) ---

test("SubagentStop payload with both fields links the agent transcript, not the parent's", () => {
  const payload: HookPayload = {
    hook_event_name: "SubagentStop",
    transcript_path: "/parent/session.jsonl",
    agent_transcript_path: "/parent/subagents/agent-abc123.jsonl",
  };
  expect(pickTranscriptPath(payload)).toBe("/parent/subagents/agent-abc123.jsonl");
});

test("Stop payload with only transcript_path falls back to it", () => {
  const payload: HookPayload = {
    hook_event_name: "Stop",
    transcript_path: "/parent/session.jsonl",
  };
  expect(pickTranscriptPath(payload)).toBe("/parent/session.jsonl");
});

test("payload with neither field yields undefined (caller skips)", () => {
  const payload: HookPayload = {
    hook_event_name: "SubagentStop",
  };
  expect(pickTranscriptPath(payload)).toBeUndefined();
});

test("empty-string agent_transcript_path is present (not nullish) so it wins over transcript_path", () => {
  // `??` only falls back on null/undefined, so "" short-circuits the fallback.
  // The caller's `if (!transcriptPath)` guard in main() still treats "" as
  // absent, so this still ends up skipping — see the end-to-end test below.
  const payload: HookPayload = {
    hook_event_name: "SubagentStop",
    transcript_path: "/parent/session.jsonl",
    agent_transcript_path: "",
  };
  expect(pickTranscriptPath(payload)).toBe("");
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
