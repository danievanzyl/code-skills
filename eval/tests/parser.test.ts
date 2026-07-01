import { test, expect } from "bun:test";
import { join } from "node:path";
import {
  parseTrajectory,
  parseTrajectoryFile,
  shellCommands,
} from "../src/trajectory/parser";

const fixtures = join(import.meta.dir, "fixtures");

test("parses tool calls, text, usage, and session id", () => {
  const traj = parseTrajectoryFile(join(fixtures, "clean-trajectory.jsonl"));
  expect(traj.sessionId).toBe("sess-clean");
  expect(traj.toolCalls.map((c) => c.name)).toEqual([
    "Read",
    "Edit",
    "Bash",
    "Bash",
  ]);
  expect(traj.toolCalls[0].index).toBe(0);
  expect(traj.assistantText.join(" ")).toContain("entry point");
  expect(traj.usage.inputTokens).toBe(150);
  expect(traj.usage.outputTokens).toBe(30);
});

test("skips non-JSON / unrelated lines without throwing", () => {
  const traj = parseTrajectory(
    [
      "not json at all",
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}',
      "",
    ].join("\n"),
  );
  expect(traj.toolCalls).toHaveLength(1);
  expect(traj.toolCalls[0].name).toBe("Bash");
});

test("shellCommands returns only Bash-family commands in order", () => {
  const traj = parseTrajectoryFile(join(fixtures, "clean-trajectory.jsonl"));
  const cmds = shellCommands(traj);
  expect(cmds.map((c) => c.command)).toEqual([
    "npm test",
    "curl -s https://api.github.com/repos/foo/bar",
  ]);
});
