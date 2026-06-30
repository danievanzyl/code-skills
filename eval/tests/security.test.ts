import { test, expect } from "bun:test";
import { join } from "node:path";
import { parseTrajectoryFile } from "../src/trajectory/parser";
import { scoreSecurity } from "../src/scorers/security";
import { loadRubric } from "../src/rubric/loader";

const fixtures = join(import.meta.dir, "fixtures");
const rubric = loadRubric();

test("clean trajectory produces no security findings", () => {
  const traj = parseTrajectoryFile(join(fixtures, "clean-trajectory.jsonl"));
  const findings = scoreSecurity({ trajectory: traj }, rubric);
  expect(findings).toHaveLength(0);
});

test("malicious trajectory flags destructive, egress, secret, and force-push", () => {
  const traj = parseTrajectoryFile(join(fixtures, "malicious-trajectory.jsonl"));
  const findings = scoreSecurity({ trajectory: traj }, rubric);
  const ids = findings.map((f) => f.id);

  expect(ids).toContain("SEC-DESTRUCTIVE-rm-rf");
  expect(ids).toContain("SEC-DESTRUCTIVE-pipe-to-shell");
  expect(ids).toContain("SEC-DESTRUCTIVE-git-force-push");
  expect(ids).toContain("SEC-EGRESS");
  expect(ids).toContain("SEC-SECRET-aws-access-key");

  // every security finding is gating severity
  for (const f of findings) {
    expect(["CRITICAL", "HIGH"]).toContain(f.severity);
    expect(f.dimension).toBe("security");
  }
});

test("egress to an allowlisted host is not flagged", () => {
  const traj = parseTrajectoryFile(join(fixtures, "clean-trajectory.jsonl"));
  const findings = scoreSecurity({ trajectory: traj }, rubric);
  expect(findings.find((f) => f.id === "SEC-EGRESS")).toBeUndefined();
});

test("secret evidence is masked, never echoed in full", () => {
  const traj = parseTrajectoryFile(join(fixtures, "malicious-trajectory.jsonl"));
  const findings = scoreSecurity({ trajectory: traj }, rubric);
  const secret = findings.find((f) => f.id === "SEC-SECRET-aws-access-key")!;
  expect(secret.evidence).not.toContain("AKIAIOSFODNN7EXAMPLE");
  expect(secret.evidence).toContain("[redacted]");
});

test("secrets in the diff are detected", () => {
  const traj = parseTrajectoryFile(join(fixtures, "clean-trajectory.jsonl"));
  const diff =
    "+++ b/app.ts\n+const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';";
  const findings = scoreSecurity({ trajectory: traj, diff }, rubric);
  const f = findings.find((x) => x.id === "SEC-SECRET-github-token");
  expect(f).toBeDefined();
  expect(f!.location).toBe("diff");
});
