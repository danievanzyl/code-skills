#!/usr/bin/env bun
/**
 * Run Evaluator CLI (see ADR-0001).
 *
 * Resolves a PR's Trajectory via the manifest, scores it against the Rubric
 * (deterministic security scorer — the v1 gate), builds a Scorecard, and either
 * prints it (default) or publishes it to the PR (--publish).
 *
 * Runs co-located with the Run, so transcripts never leave the box.
 *
 *   bun run scripts/eval-pr.ts --pr 123                       # dry-run, print
 *   bun run scripts/eval-pr.ts --pr 123 --repo owner/repo --publish
 *   bun run scripts/eval-pr.ts --pr 123 --transcript ./t.jsonl --diff ./pr.diff
 */
import { readFileSync } from "node:fs";
import { loadRubric } from "../src/rubric/loader";
import { parseTrajectoryFile } from "../src/trajectory/parser";
import { scoreSecurity } from "../src/scorers/security";
import { buildScorecard, renderMarkdown } from "../src/scorecard/build";
import { latestRunForPr, latestRunForPrByRole } from "../src/manifest";
import { publishScorecard } from "../src/publish/gh";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

async function ghPrDiff(pr: number, repo: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["gh", "pr", "diff", String(pr), "--repo", repo], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return code === 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const pr = Number(args.pr);
  if (!pr) {
    process.stderr.write("error: --pr <number> is required\n");
    return 2;
  }

  const rubric = loadRubric(typeof args.rubric === "string" ? args.rubric : undefined);

  // Resolve the Runner Trajectory: explicit --transcript wins, else manifest (by role).
  let transcriptPath: string | undefined;
  let sha: string | undefined = typeof args.sha === "string" ? args.sha : undefined;
  let runId: string | undefined =
    typeof args["run-id"] === "string" ? (args["run-id"] as string) : undefined;
  const manifestPath = typeof args.manifest === "string" ? args.manifest : undefined;

  if (typeof args.transcript === "string") {
    transcriptPath = args.transcript;
  } else {
    // Prefer role-filtered lookup (absent role treated as runner for back-compat).
    // Fall back to unfiltered latestRunForPr only as defense-in-depth: if future
    // changes alter the absent-role assumption, this avoids a hard error.
    const entry =
      latestRunForPrByRole(pr, "runner", manifestPath) ??
      latestRunForPr(pr, manifestPath);
    if (!entry) {
      process.stderr.write(
        `error: no manifest entry for PR #${pr}. Pass --transcript or check the capture hook.\n`,
      );
      return 2;
    }
    transcriptPath = entry.transcriptPath;
    sha ??= entry.sha;
    runId ??= entry.runId;
  }

  const trajectory = parseTrajectoryFile(transcriptPath);

  // Resolve the Reviewer Trajectory independently (optional — may not exist yet).
  let reviewerTranscriptPath: string | undefined;
  if (typeof args["reviewer-transcript"] === "string") {
    reviewerTranscriptPath = args["reviewer-transcript"];
  } else {
    const reviewerEntry = latestRunForPrByRole(pr, "reviewer", manifestPath);
    reviewerTranscriptPath = reviewerEntry?.transcriptPath;
  }
  const reviewerTrajectory = reviewerTranscriptPath
    ? parseTrajectoryFile(reviewerTranscriptPath)
    : undefined;
  if (reviewerTranscriptPath) {
    process.stderr.write(
      `run-eval: resolved reviewer trajectory from ${reviewerTranscriptPath}\n`,
    );
  }

  // Resolve the diff: explicit --diff file, else gh pr diff when a repo is known.
  let diff: string | undefined;
  if (typeof args.diff === "string") {
    diff = readFileSync(args.diff, "utf8");
  } else if (typeof args.repo === "string") {
    diff = await ghPrDiff(pr, args.repo);
  }

  // Score runner trajectory (the primary gate input).
  const securityFindings = scoreSecurity({ trajectory, diff }, rubric);

  // Score reviewer trajectory independently (advisory — findings attributed separately).
  // In v1 we merge them into one security dimension; per-role attribution is #24.
  if (reviewerTrajectory) {
    const reviewerFindings = scoreSecurity({ trajectory: reviewerTrajectory }, rubric);
    securityFindings.push(...reviewerFindings);
  }

  const card = buildScorecard({
    pr,
    sha,
    runId,
    rubricVersion: rubric.version,
    generatedAt: new Date().toISOString(),
    securityFindings,
  });

  if (args.publish) {
    if (typeof args.repo !== "string") {
      process.stderr.write("error: --publish requires --repo owner/repo\n");
      return 2;
    }
    await publishScorecard(card, { repo: args.repo });
    process.stderr.write(
      `published scorecard for PR #${pr}: gate ${card.gate.state}\n`,
    );
  } else {
    process.stdout.write(renderMarkdown(card) + "\n\n");
    process.stdout.write(JSON.stringify(card, null, 2) + "\n");
  }

  if (args["fail-on-gate"] && card.gate.state === "failure") return 1;
  return 0;
}

main().then((code) => process.exit(code));
