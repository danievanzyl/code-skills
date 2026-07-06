#!/usr/bin/env bun
/**
 * Capture hook — the Trajectory↔PR linker (see ADR-0001).
 *
 * Wire into Claude Code as BOTH a `Stop` hook (headless afk.sh, where the Runner
 * is the top-level agent) and a `SubagentStop` hook (afk-issue, where the Runner
 * is a spawned sub-agent). On each Runner finish it derives the PR from the
 * worktree and appends an entry to the manifest.
 *
 * Pass --role runner|reviewer (default: runner). The reviewer path wires this via
 * the code-reviewer SubagentStop with --role reviewer, before the Evaluator runs.
 *
 * It is a linker, never a collector: it records WHERE the transcript is, it does
 * not parse or copy it. It must never block the agent — it always exits 0.
 */
import { existsSync } from "node:fs";
import { appendRun, type RunEntry, type AgentRole } from "../src/manifest";

export interface HookPayload {
  transcript_path?: string;
  agent_transcript_path?: string;
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
}

// SubagentStop payloads carry both `transcript_path` (the parent session's
// transcript) and `agent_transcript_path` (the subagent's own transcript).
// Prefer the agent's transcript so the Evaluator scores the right Trajectory.
// Stop payloads (headless afk.sh, no parent) carry only `transcript_path`.
//
// The CLI can advertise an `agent_transcript_path` that was never written to
// disk (e.g. internal harness agents on SubagentStop — 2026-07-06 incident).
// Only link a path that actually exists, falling back to `transcript_path`,
// else giving up — never link a phantom path into the manifest (issue #37).
export function pickTranscriptPath(
  payload: HookPayload,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const { agent_transcript_path, transcript_path } = payload;
  if (agent_transcript_path && exists(agent_transcript_path)) {
    return agent_transcript_path;
  }
  if (transcript_path && exists(transcript_path)) {
    return transcript_path;
  }
  return undefined;
}

async function ghPrInfo(cwd: string): Promise<{ pr: number; sha?: string } | null> {
  try {
    const proc = Bun.spawn(
      ["gh", "pr", "view", "--json", "number,headRefOid"],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (code !== 0) return null;
    const data = JSON.parse(out) as { number?: number; headRefOid?: string };
    if (typeof data.number !== "number") return null;
    return { pr: data.number, sha: data.headRefOid };
  } catch {
    return null;
  }
}

function parseRole(argv: string[]): AgentRole {
  const idx = argv.indexOf("--role");
  if (idx !== -1 && argv[idx + 1]) {
    const v = argv[idx + 1];
    if (v === "reviewer") return "reviewer";
  }
  return "runner";
}

async function main(): Promise<void> {
  const role = parseRole(process.argv.slice(2));

  const stdin = await Bun.stdin.text();
  let payload: HookPayload = {};
  try {
    payload = JSON.parse(stdin) as HookPayload;
  } catch {
    // No/invalid payload — nothing to link.
    return;
  }

  const cwd = payload.cwd ?? process.cwd();
  const transcriptPath = pickTranscriptPath(payload);
  if (!transcriptPath) {
    if (payload.agent_transcript_path || payload.transcript_path) {
      process.stderr.write(
        "run-eval/capture: no transcript file exists on disk " +
          `(agent_transcript_path=${payload.agent_transcript_path ?? "none"}, ` +
          `transcript_path=${payload.transcript_path ?? "none"}); skipping\n`,
      );
    } else {
      process.stderr.write("run-eval/capture: no transcript_path in payload; skipping\n");
    }
    return;
  }

  const info = await ghPrInfo(cwd);
  if (!info) {
    process.stderr.write("run-eval/capture: no PR for this worktree; skipping\n");
    return;
  }

  const entry: RunEntry = {
    pr: info.pr,
    transcriptPath,
    sha: info.sha,
    runId: payload.session_id,
    event: payload.hook_event_name,
    role,
    ts: new Date().toISOString(),
  };
  appendRun(entry);
  process.stderr.write(
    `run-eval/capture: linked PR #${info.pr} → ${transcriptPath} (role=${role})\n`,
  );
}

// Never block the agent: swallow everything and exit 0.
// Guarded so importing this module (e.g. from tests) doesn't run main().
if (import.meta.main) {
  main()
    .catch((e) => process.stderr.write(`run-eval/capture: ${String(e)}\n`))
    .finally(() => process.exit(0));
}
