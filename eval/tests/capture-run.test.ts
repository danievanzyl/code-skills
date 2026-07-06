import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEntry } from "../src/manifest";
import { pickTranscriptPath, agentTypeAllowsRole, type HookPayload } from "../scripts/capture-run";

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

// --- agent_type role gating (issue #39) ---
//
// A phantom SubagentStop event can run both matcher groups (afk-task-runner
// AND code-reviewer) despite mutually exclusive matchers, corrupting role
// attribution. Gate on the payload's own agent_type declaration: refuse to
// write role=reviewer unless agent_type is code-reviewer (namespaced or not),
// and refuse role=runner from SubagentStop unless agent_type is
// afk-task-runner. Stop payloads carry no agent_type and are unaffected.

test("agentTypeAllowsRole: SubagentStop + role=runner + agent_type=afk-task-runner → true", () => {
  expect(
    agentTypeAllowsRole(
      { hook_event_name: "SubagentStop", agent_type: "afk-task-runner" },
      "runner",
    ),
  ).toBe(true);
});

test("agentTypeAllowsRole: SubagentStop + role=runner + namespaced agent_type → true", () => {
  expect(
    agentTypeAllowsRole(
      { hook_event_name: "SubagentStop", agent_type: "agentic-platform:afk-task-runner" },
      "runner",
    ),
  ).toBe(true);
});

test("agentTypeAllowsRole: SubagentStop + role=runner + agent_type=code-reviewer → false", () => {
  expect(
    agentTypeAllowsRole(
      { hook_event_name: "SubagentStop", agent_type: "code-reviewer" },
      "runner",
    ),
  ).toBe(false);
});

test("agentTypeAllowsRole: SubagentStop + role=runner + missing agent_type → false", () => {
  expect(agentTypeAllowsRole({ hook_event_name: "SubagentStop" }, "runner")).toBe(false);
});

test("agentTypeAllowsRole: SubagentStop + role=reviewer + agent_type=code-reviewer → true", () => {
  expect(
    agentTypeAllowsRole(
      { hook_event_name: "SubagentStop", agent_type: "code-reviewer" },
      "reviewer",
    ),
  ).toBe(true);
});

test("agentTypeAllowsRole: SubagentStop + role=reviewer + namespaced agent_type → true", () => {
  expect(
    agentTypeAllowsRole(
      { hook_event_name: "SubagentStop", agent_type: "agentic-platform:code-reviewer" },
      "reviewer",
    ),
  ).toBe(true);
});

test("agentTypeAllowsRole: SubagentStop + role=reviewer + agent_type=afk-task-runner → false", () => {
  expect(
    agentTypeAllowsRole(
      { hook_event_name: "SubagentStop", agent_type: "afk-task-runner" },
      "reviewer",
    ),
  ).toBe(false);
});

test("agentTypeAllowsRole: SubagentStop + role=reviewer + missing agent_type → false", () => {
  expect(agentTypeAllowsRole({ hook_event_name: "SubagentStop" }, "reviewer")).toBe(false);
});

test("agentTypeAllowsRole: SubagentStop + role=reviewer + internal/phantom agent_type → false", () => {
  expect(
    agentTypeAllowsRole(
      { hook_event_name: "SubagentStop", agent_type: "away-summary" },
      "reviewer",
    ),
  ).toBe(false);
});

test("agentTypeAllowsRole: Stop payload (no agent_type) → true regardless of role (back-compat)", () => {
  expect(agentTypeAllowsRole({ hook_event_name: "Stop" }, "runner")).toBe(true);
  expect(agentTypeAllowsRole({ hook_event_name: "Stop" }, "reviewer")).toBe(true);
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

function runCapture(
  payload: unknown,
  stateDir: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<CaptureResult> {
  const scriptPath = join(import.meta.dir, "../scripts/capture-run.ts");
  const proc = Bun.spawn(["bun", "run", scriptPath, ...args], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RUN_EVAL_STATE_DIR: stateDir, ...extraEnv },
  });
  return Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([out, err, code]) => ({ out, err, code }));
}

/** Writes a fake `gh` executable that answers `gh pr view --json ...` and
 * prepends its directory to PATH, so ghPrInfo() succeeds without a real repo. */
function fakeGhOnPath(dir: string, pr: number, sha: string): Record<string, string> {
  const ghPath = join(dir, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash\necho '{"number": ${pr}, "headRefOid": "${sha}"}'\n`,
    "utf8",
  );
  chmodSync(ghPath, 0o755);
  return { PATH: `${dir}:${process.env.PATH ?? ""}` };
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

// --- Happy path: fallback link still preserves every other RunEntry field ---
//
// The existence check must only change *which* transcript gets linked, never
// touch the rest of the entry — pr/sha come from `gh pr view`, runId/event
// come straight from the payload, and role comes from the untouched --role
// flag. Regression guard: a careless refactor of pickTranscriptPath's caller
// could drop or shadow one of these when wiring in the new fallback branch.

test("fallback-linked entry preserves pr, sha, runId, event, role and ts untouched", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "run-eval-capture-"));
  const binDir = mkdtempSync(join(tmpdir(), "run-eval-fakebin-"));
  const parentPath = tmpFile(stateDir, "session.jsonl");
  const phantomAgentPath = join(stateDir, "subagents", "agent-phantom.jsonl"); // never written
  const extraEnv = fakeGhOnPath(binDir, 42, "deadbeefcafe");

  const before = Date.now();
  const { err, code } = await runCapture(
    {
      hook_event_name: "SubagentStop",
      transcript_path: parentPath,
      agent_transcript_path: phantomAgentPath,
      session_id: "sess-123",
      agent_type: "code-reviewer", // matches --role reviewer (issue #39 gate)
    },
    stateDir,
    ["--role", "reviewer"],
    extraEnv,
  );
  const after = Date.now();

  expect(code).toBe(0);
  expect(err).toContain(`linked PR #42 → ${parentPath} (role=reviewer)`);

  const manifestPath = join(stateDir, "manifest.jsonl");
  const lines = readFileSync(manifestPath, "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0]) as RunEntry;

  expect(entry.pr).toBe(42);
  expect(entry.sha).toBe("deadbeefcafe");
  expect(entry.transcriptPath).toBe(parentPath); // fallback path, not the phantom
  expect(entry.runId).toBe("sess-123");
  expect(entry.event).toBe("SubagentStop");
  expect(entry.role).toBe("reviewer"); // --role forwarded untouched
  expect(entry.agentType).toBe("code-reviewer");
  const tsMs = new Date(entry.ts).getTime();
  expect(tsMs).toBeGreaterThanOrEqual(before);
  expect(tsMs).toBeLessThanOrEqual(after);
});

test("fallback-linked entry defaults role to runner when --role is omitted", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "run-eval-capture-"));
  const binDir = mkdtempSync(join(tmpdir(), "run-eval-fakebin-"));
  const parentPath = tmpFile(stateDir, "session.jsonl");
  const phantomAgentPath = join(stateDir, "subagents", "agent-phantom.jsonl"); // never written
  const extraEnv = fakeGhOnPath(binDir, 7, "abc123");

  const { code } = await runCapture(
    {
      hook_event_name: "SubagentStop",
      transcript_path: parentPath,
      agent_transcript_path: phantomAgentPath,
      agent_type: "afk-task-runner", // matches default role=runner (issue #39 gate)
    },
    stateDir,
    [],
    extraEnv,
  );
  expect(code).toBe(0);

  const entry = JSON.parse(
    readFileSync(join(stateDir, "manifest.jsonl"), "utf8").trim(),
  ) as RunEntry;
  expect(entry.role).toBe("runner");
  expect(entry.transcriptPath).toBe(parentPath);
  expect(entry.agentType).toBe("afk-task-runner");
});

// --- Regression: 2026-07-06 incident #2 — phantom SubagentStop ran both
// matcher groups (issue #39) ---
//
// One SubagentStop event fired with a phantom/internal agent_type (or none)
// ran BOTH hooks.json matcher groups despite mutually exclusive matchers —
// the same trajectory was written as role=runner AND role=reviewer 40ms
// apart. Replay both invocations against the same payload; neither must
// write a manifest entry. A legitimate code-reviewer payload with
// --role reviewer must still write exactly one, correctly-attributed entry.

test("regression: phantom agent_type through both role invocations yields zero manifest entries", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "run-eval-capture-"));
  const binDir = mkdtempSync(join(tmpdir(), "run-eval-fakebin-"));
  const transcriptPath = tmpFile(stateDir, "session.jsonl");
  const extraEnv = fakeGhOnPath(binDir, 99, "cafebabe");
  const phantomPayload = {
    hook_event_name: "SubagentStop",
    transcript_path: transcriptPath,
    agent_type: "away-summary", // internal harness agent — matches neither matcher
  };

  const runnerResult = await runCapture(phantomPayload, stateDir, [], extraEnv);
  const reviewerResult = await runCapture(
    phantomPayload,
    stateDir,
    ["--role", "reviewer"],
    extraEnv,
  );

  expect(runnerResult.code).toBe(0);
  expect(reviewerResult.code).toBe(0);
  expect(existsSync(join(stateDir, "manifest.jsonl"))).toBe(false);
});

test("regression: missing agent_type through both role invocations yields zero manifest entries", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "run-eval-capture-"));
  const binDir = mkdtempSync(join(tmpdir(), "run-eval-fakebin-"));
  const transcriptPath = tmpFile(stateDir, "session.jsonl");
  const extraEnv = fakeGhOnPath(binDir, 99, "cafebabe");
  const phantomPayload = {
    hook_event_name: "SubagentStop",
    transcript_path: transcriptPath,
  };

  const runnerResult = await runCapture(phantomPayload, stateDir, [], extraEnv);
  const reviewerResult = await runCapture(
    phantomPayload,
    stateDir,
    ["--role", "reviewer"],
    extraEnv,
  );

  expect(runnerResult.code).toBe(0);
  expect(reviewerResult.code).toBe(0);
  expect(existsSync(join(stateDir, "manifest.jsonl"))).toBe(false);
});

test("legitimate code-reviewer payload with --role reviewer yields exactly one entry with agentType recorded", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "run-eval-capture-"));
  const binDir = mkdtempSync(join(tmpdir(), "run-eval-fakebin-"));
  const transcriptPath = tmpFile(stateDir, "session.jsonl");
  const extraEnv = fakeGhOnPath(binDir, 99, "cafebabe");
  const payload = {
    hook_event_name: "SubagentStop",
    transcript_path: transcriptPath,
    agent_type: "code-reviewer",
  };

  const { code } = await runCapture(payload, stateDir, ["--role", "reviewer"], extraEnv);
  expect(code).toBe(0);

  const lines = readFileSync(join(stateDir, "manifest.jsonl"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0]) as RunEntry;
  expect(entry.role).toBe("reviewer");
  expect(entry.agentType).toBe("code-reviewer");
});
