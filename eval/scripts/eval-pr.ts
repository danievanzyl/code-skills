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
import { existsSync, readFileSync } from "node:fs";
import { loadRubric } from "../src/rubric/loader";
import { parseTrajectoryFile } from "../src/trajectory/parser";
import { scoreSecurity } from "../src/scorers/security";
import { scoreEfficiency } from "../src/scorers/efficiency";
import { buildScorecard, renderMarkdown } from "../src/scorecard/build";
import {
  latestRunForPr,
  latestRunForPrByRole,
  latestExistingRunForPrByRole,
} from "../src/manifest";
import { publishScorecard } from "../src/publish/gh";
import { resolveVersion } from "../src/version";
import { persistScorecard } from "../src/store";

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
    // Resolve the newest runner entry WHOSE transcript still exists on disk,
    // walking back past phantom paths (e.g. a SubagentStop advertised a
    // transcript that was never written — 2026-07-06 incident, issue #38).
    // Fall back to unfiltered latestRunForPr only as defense-in-depth: if future
    // changes alter the absent-role assumption, this avoids a hard error.
    const fallback = latestRunForPr(pr, manifestPath);
    const entry =
      latestExistingRunForPrByRole(pr, "runner", manifestPath) ??
      (fallback && existsSync(fallback.transcriptPath) ? fallback : null);
    if (!entry) {
      process.stderr.write(
        `error: no manifest entry with an existing transcript for PR #${pr}. Pass --transcript or check the capture hook.\n`,
      );
      return 2;
    }
    transcriptPath = entry.transcriptPath;
    sha ??= entry.sha;
    runId ??= entry.runId;
  }

  const trajectory = parseTrajectoryFile(transcriptPath);

  // Resolve the Reviewer Trajectory independently (optional — may not exist yet,
  // and a missing file must not block the runner-only eval, issue #38).
  let reviewerTranscriptPath: string | undefined;
  if (typeof args["reviewer-transcript"] === "string") {
    reviewerTranscriptPath = args["reviewer-transcript"];
  } else {
    const reviewerEntry = latestExistingRunForPrByRole(pr, "reviewer", manifestPath);
    reviewerTranscriptPath = reviewerEntry?.transcriptPath;
    if (!reviewerEntry && latestRunForPrByRole(pr, "reviewer", manifestPath)) {
      process.stderr.write(
        "run-eval: reviewer manifest entry's transcript is missing on disk; proceeding runner-only\n",
      );
    }
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

  // Efficiency dimension: advisory, never gates. Per-role (ADR-0001 Delta A, issue #23).
  const advisory = [
    scoreEfficiency({ role: "runner", trajectory }),
    ...(reviewerTrajectory
      ? [scoreEfficiency({ role: "reviewer", trajectory: reviewerTrajectory })]
      : []),
  ];

  // Resolve plugin version stamp best-effort (Delta D, issue #25). Never throws.
  const version = await resolveVersion();

  const card = buildScorecard({
    pr,
    sha,
    runId,
    rubricVersion: rubric.version,
    generatedAt: new Date().toISOString(),
    securityFindings,
    advisory,
    version: Object.keys(version).length > 0 ? version : undefined,
  });

  // Persist Scorecard to on-box JSONL log (Delta D, issue #25). Best-effort.
  persistScorecard(card);

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
