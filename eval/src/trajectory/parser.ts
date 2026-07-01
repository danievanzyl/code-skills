import { readFileSync } from "node:fs";
import type { ToolCall, Trajectory } from "../types";

/**
 * Parse a Claude Code transcript `.jsonl` (or `claude --output-format stream-json`
 * output) into a structured Trajectory.
 *
 * Both formats wrap the model turn in `{ ..., message: { role, content, usage } }`,
 * where `content` is an array of blocks. We extract `tool_use` and `text` blocks
 * and sum token usage. Lines that don't parse are skipped (the stream interleaves
 * other event types we don't need here).
 */
export function parseTrajectory(jsonl: string): Trajectory {
  const toolCalls: ToolCall[] = [];
  const assistantText: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let sessionId: string | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let lineCount = 0;

  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // not a JSON line we care about
    }
    lineCount++;

    sessionId ??= obj.sessionId ?? obj.session_id;

    // Extract wall-clock timestamps: ts takes priority over timestamp.
    const ts: string | undefined =
      typeof obj.ts === "string"
        ? obj.ts
        : typeof obj.timestamp === "string"
          ? obj.timestamp
          : undefined;
    if (ts) {
      firstTimestamp ??= ts;
      lastTimestamp = ts;
    }

    const message = obj.message ?? obj;
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    const usage = message?.usage;
    if (usage) {
      inputTokens += Number(usage.input_tokens ?? 0) || 0;
      outputTokens += Number(usage.output_tokens ?? 0) || 0;
      cacheReadTokens += Number(usage.cache_read_input_tokens ?? 0) || 0;
    }

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use" && typeof block.name === "string") {
        toolCalls.push({
          id: typeof block.id === "string" ? block.id : undefined,
          name: block.name,
          input:
            block.input && typeof block.input === "object" ? block.input : {},
          index: toolCalls.length,
        });
      } else if (block.type === "text" && typeof block.text === "string") {
        assistantText.push(block.text);
      }
    }
  }

  return {
    sessionId,
    toolCalls,
    assistantText,
    usage: { inputTokens, outputTokens, cacheReadTokens },
    firstTimestamp,
    lastTimestamp,
    lineCount,
  };
}

/** Parse a transcript file by path. */
export function parseTrajectoryFile(path: string): Trajectory {
  return parseTrajectory(readFileSync(path, "utf8"));
}

/**
 * Flatten the shell commands a Run executed, in order.
 * Looks at Bash-family tool calls and returns their `command` strings.
 */
export function shellCommands(traj: Trajectory): { index: number; command: string }[] {
  const out: { index: number; command: string }[] = [];
  for (const call of traj.toolCalls) {
    if (!/^(Bash|Shell|Exec)$/i.test(call.name)) continue;
    const cmd = call.input["command"];
    if (typeof cmd === "string" && cmd.trim()) {
      out.push({ index: call.index, command: cmd });
    }
  }
  return out;
}
