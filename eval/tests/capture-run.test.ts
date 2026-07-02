import { test, expect } from "bun:test";
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
