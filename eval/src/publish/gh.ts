import type { Scorecard } from "../types";
import { renderMarkdown } from "../scorecard/build";

/**
 * A command runner. Injectable so tests can assert calls without invoking gh.
 * Returns stdout; throws on non-zero exit.
 */
export type Runner = (cmd: string[], stdin?: string) => Promise<string>;

/** Default runner backed by Bun.spawn. */
export const bunRunner: Runner = async (cmd, stdin) => {
  const proc = Bun.spawn(cmd, {
    stdin: stdin ? new TextEncoder().encode(stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${cmd.join(" ")}\n${err}`);
  }
  return out;
};

export interface PublishOptions {
  /** "owner/repo" for gh API calls. */
  repo: string;
  runner?: Runner;
}

/**
 * Publish a Scorecard to the PR:
 *  - a commit status on the head SHA for the gating check (eval/security)
 *  - a Markdown comment with the full Scorecard
 *
 * Read-only with respect to the diff — it never pushes commits.
 */
export async function publishScorecard(
  card: Scorecard,
  opts: PublishOptions,
): Promise<void> {
  const run = opts.runner ?? bunRunner;

  if (card.sha) {
    await run([
      "gh",
      "api",
      "--method",
      "POST",
      `repos/${opts.repo}/statuses/${card.sha}`,
      "-f",
      `state=${card.gate.state}`,
      "-f",
      `context=${card.gate.check}`,
      "-f",
      `description=${card.gate.description}`,
    ]);
  }

  await run(
    ["gh", "pr", "comment", String(card.pr), "--repo", opts.repo, "--body-file", "-"],
    renderMarkdown(card),
  );
}
