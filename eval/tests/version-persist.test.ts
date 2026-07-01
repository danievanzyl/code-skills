/**
 * Tests for Delta D: version stamp + on-box Scorecard persistence (issue #25).
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVersion } from "../src/version";
import {
  persistScorecard,
  scorecardsForPr,
  scorecardsForPluginVersion,
  scorecardsForSha,
} from "../src/store";
import { buildScorecard } from "../src/scorecard/build";
import type { Scorecard, PluginVersion } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "run-eval-store-"));
}

function tmpLog(dir?: string): string {
  return join(dir ?? tmpDir(), "scorecards.jsonl");
}

function makeCard(pr: number, version?: PluginVersion): Scorecard {
  return buildScorecard({
    pr,
    rubricVersion: 1,
    generatedAt: new Date().toISOString(),
    securityFindings: [],
    version,
  });
}

// ---------------------------------------------------------------------------
// Version stamp type — PluginVersion on Scorecard
// ---------------------------------------------------------------------------

test("Scorecard can carry a PluginVersion", () => {
  const card = makeCard(1, { plugin: "0.1.15", sha: "abc123" });
  expect(card.version?.plugin).toBe("0.1.15");
  expect(card.version?.sha).toBe("abc123");
});

test("Scorecard version is optional — absent when not supplied", () => {
  const card = makeCard(2);
  expect(card.version).toBeUndefined();
});

test("PluginVersion allows partial fields (plugin only)", () => {
  const card = makeCard(3, { plugin: "0.1.15" });
  expect(card.version?.plugin).toBe("0.1.15");
  expect(card.version?.sha).toBeUndefined();
});

test("PluginVersion allows partial fields (sha only)", () => {
  const card = makeCard(4, { sha: "deadbeef" });
  expect(card.version?.sha).toBe("deadbeef");
  expect(card.version?.plugin).toBeUndefined();
});

// ---------------------------------------------------------------------------
// resolveVersion — best-effort, never throws
// ---------------------------------------------------------------------------

test("resolveVersion returns PluginVersion object — never throws", async () => {
  // Pass a non-existent root — both fields should be absent, no throw.
  const v = await resolveVersion("/nonexistent/path/xyz");
  expect(typeof v).toBe("object");
  // Fields may be absent but the object itself must be returned.
  expect(v).toBeDefined();
});

test("resolveVersion resolves plugin version from a real plugin.json", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ version: "1.2.3" }));
  // No git repo → sha will be absent; plugin should resolve.
  const v = await resolveVersion(dir);
  expect(v.plugin).toBe("1.2.3");
});

test("resolveVersion tolerates malformed plugin.json — returns empty version", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "plugin.json"), "NOT_JSON{{{{");
  const v = await resolveVersion(dir);
  expect(v.plugin).toBeUndefined();
});

test("resolveVersion tolerates missing plugin.json — returns empty version", async () => {
  const v = await resolveVersion(tmpDir());
  expect(v.plugin).toBeUndefined();
  // sha also undefined for non-git dirs
  expect(v.sha).toBeUndefined();
});

test("resolveVersion resolves plugin.json with non-string version gracefully", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ version: 42 }));
  const v = await resolveVersion(dir);
  expect(v.plugin).toBeUndefined(); // non-string version not accepted
});

// ---------------------------------------------------------------------------
// persistScorecard — append-only JSONL
// ---------------------------------------------------------------------------

test("persistScorecard writes a valid JSON line", () => {
  const log = tmpLog();
  const card = makeCard(10, { plugin: "0.1.15", sha: "sha1" });
  persistScorecard(card, log);
  const line = readFileSync(log, "utf8").trim();
  const parsed = JSON.parse(line) as Scorecard;
  expect(parsed.pr).toBe(10);
  expect(parsed.version?.plugin).toBe("0.1.15");
});

test("persistScorecard appends multiple entries", () => {
  const log = tmpLog();
  persistScorecard(makeCard(11, { plugin: "0.1.0" }), log);
  persistScorecard(makeCard(12, { plugin: "0.1.1" }), log);
  persistScorecard(makeCard(11, { plugin: "0.1.1" }), log);
  expect(scorecardsForPr(11, log)).toHaveLength(2);
  expect(scorecardsForPr(12, log)).toHaveLength(1);
});

test("persistScorecard is a no-op on unwritable paths — never throws", () => {
  // Pass a path under /nonexistent — mkdirSync will fail; must not throw.
  expect(() => persistScorecard(makeCard(1), "/nonexistent/deep/path/s.jsonl")).not.toThrow();
});

// ---------------------------------------------------------------------------
// scorecardsForPr — query by PR
// ---------------------------------------------------------------------------

test("scorecardsForPr returns entries in write order", () => {
  const log = tmpLog();
  persistScorecard(makeCard(20, { plugin: "0.1.0" }), log);
  persistScorecard(makeCard(21, { plugin: "0.1.1" }), log);
  persistScorecard(makeCard(20, { plugin: "0.1.2" }), log);
  const cards = scorecardsForPr(20, log);
  expect(cards).toHaveLength(2);
  expect(cards[0].version?.plugin).toBe("0.1.0");
  expect(cards[1].version?.plugin).toBe("0.1.2");
});

test("scorecardsForPr returns [] for missing log — no throw", () => {
  expect(scorecardsForPr(1, "/nonexistent/scorecards.jsonl")).toEqual([]);
});

test("scorecardsForPr returns [] for unknown PR", () => {
  const log = tmpLog();
  persistScorecard(makeCard(30), log);
  expect(scorecardsForPr(999, log)).toEqual([]);
});

// ---------------------------------------------------------------------------
// scorecardsForPluginVersion — query by plugin version
// ---------------------------------------------------------------------------

test("scorecardsForPluginVersion returns matching entries", () => {
  const log = tmpLog();
  persistScorecard(makeCard(40, { plugin: "0.1.15" }), log);
  persistScorecard(makeCard(41, { plugin: "0.1.16" }), log);
  persistScorecard(makeCard(42, { plugin: "0.1.15" }), log);
  const hits = scorecardsForPluginVersion("0.1.15", log);
  expect(hits).toHaveLength(2);
  expect(hits.every((c) => c.version?.plugin === "0.1.15")).toBe(true);
});

test("scorecardsForPluginVersion returns [] when no match", () => {
  const log = tmpLog();
  persistScorecard(makeCard(50, { plugin: "0.1.0" }), log);
  expect(scorecardsForPluginVersion("9.9.9", log)).toEqual([]);
});

test("scorecardsForPluginVersion — entries without version field not returned", () => {
  const log = tmpLog();
  persistScorecard(makeCard(51), log); // no version
  expect(scorecardsForPluginVersion("0.1.0", log)).toEqual([]);
});

// ---------------------------------------------------------------------------
// scorecardsForSha — query by SHA (with prefix match)
// ---------------------------------------------------------------------------

test("scorecardsForSha returns exact and prefix matches", () => {
  const log = tmpLog();
  persistScorecard(makeCard(60, { sha: "deadbeef1234" }), log);
  persistScorecard(makeCard(61, { sha: "cafebabe5678" }), log);
  persistScorecard(makeCard(62, { sha: "deadbeef9999" }), log);

  const full = scorecardsForSha("deadbeef1234", log);
  expect(full).toHaveLength(1);
  expect(full[0].pr).toBe(60);

  const prefix = scorecardsForSha("deadbeef", log);
  expect(prefix).toHaveLength(2);
});

test("scorecardsForSha returns [] when no match", () => {
  const log = tmpLog();
  persistScorecard(makeCard(70, { sha: "abc123" }), log);
  expect(scorecardsForSha("zzz", log)).toEqual([]);
});

// ---------------------------------------------------------------------------
// Integration: buildScorecard accepts version; persist + query round-trip
// ---------------------------------------------------------------------------

test("full round-trip: build with version, persist, query by pr and version", () => {
  const log = tmpLog();
  const version: PluginVersion = { plugin: "0.1.15", sha: "fullsha9999" };
  const card = makeCard(80, version);

  persistScorecard(card, log);

  const byPr = scorecardsForPr(80, log);
  expect(byPr).toHaveLength(1);
  expect(byPr[0].version?.plugin).toBe("0.1.15");
  expect(byPr[0].version?.sha).toBe("fullsha9999");

  const byVersion = scorecardsForPluginVersion("0.1.15", log);
  expect(byVersion).toHaveLength(1);

  const bySha = scorecardsForSha("fullsha", log);
  expect(bySha).toHaveLength(1);
  expect(bySha[0].pr).toBe(80);
});
