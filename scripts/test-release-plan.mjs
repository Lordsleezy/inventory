import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessChecks, classifyDeploy, migrationsFromPushOutput, prTitlesFromLog, REQUIRED_CHECK_NAMES } from "./release/plan.mjs";
import { RELEASE_CRON, RELEASE_HOUR, isReleaseWindow } from "./release/schedule.mjs";
import { sitesForFiles } from "./release/sites.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("release cron matches the daily workflow and is 6 Pacific", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/daily-release.yml"), "utf8");
  assert.match(workflow, new RegExp(RELEASE_CRON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(RELEASE_HOUR, 6);
  assert.equal(isReleaseWindow(new Date("2026-07-01T13:30:00Z")), true);
  assert.equal(isReleaseWindow(new Date("2026-07-01T14:30:00Z")), false);
  assert.equal(isReleaseWindow(new Date("2026-01-15T14:10:00Z")), true);
  assert.equal(isReleaseWindow(new Date("2026-01-15T13:10:00Z")), false);
  assert.equal(isReleaseWindow(new Date("2026-11-02T14:05:00Z")), true);
  assert.equal(isReleaseWindow(new Date("2026-10-30T13:00:00Z")), true);
});

test("required CI names are the sql-tests jobs", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/sql-tests.yml"), "utf8");
  for (const name of REQUIRED_CHECK_NAMES) assert.match(workflow, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("CI assessment waits on pending and rejects failures", () => {
  const names = REQUIRED_CHECK_NAMES;
  const runs = names.map((name) => ({ name, status: "completed", conclusion: "success", started_at: "2026-10-30T12:00:00Z" }));
  assert.equal(assessChecks(runs).ok, true);
  runs[0] = { ...runs[0], status: "in_progress", conclusion: null };
  const pending = assessChecks(runs);
  assert.equal(pending.ok, false);
  assert.equal(pending.pending.length, 1);
  const older = { name: names[1], status: "completed", conclusion: "failure", started_at: "2026-10-30T11:00:00Z" };
  const newer = { name: names[1], status: "completed", conclusion: "success", started_at: "2026-10-30T12:30:00Z" };
  const mixed = assessChecks([older, newer, runs[0], runs[2]]);
  assert.deepEqual(mixed.failed, []);
});

test("ignore skips and path filters", () => {
  assert.equal(classifyDeploy({ state: "error", error_message: "Canceled build due to no content change" }), "skipped");
  assert.equal(classifyDeploy({ state: "ready" }), "deployed");
  assert.equal(classifyDeploy({ state: "building" }), "pending");
  assert.equal(classifyDeploy({ state: "error", error_message: "build failed" }), "failed");
  const admin = sitesForFiles(["apps/admin/netlify.toml", "AGENTS.md"]);
  assert.deepEqual(admin.map((site) => site.name), ["openbox-floor-admin"]);
  const both = sitesForFiles(["shared/foo.js", "package.json"]);
  assert.equal(both.length, 2);
  assert.equal(sitesForFiles(["AGENTS.md", ".github/workflows/daily-release.yml"]).length, 0);
});

test("migration names and PR titles", () => {
  const text = "Would push these migrations:\n • 20261030120000_release_note.sql\nRemote database is up to date.\n";
  assert.deepEqual(migrationsFromPushOutput(text), ["20261030120000_release_note.sql"]);
  assert.deepEqual(migrationsFromPushOutput("Remote database is up to date."), []);
  const log = "Merge pull request #204 from Lordsleezy/codex/daily-release\nPublish from the release branch\n---\nFix a typo in a comment\n---\n";
  assert.deepEqual(prTitlesFromLog(log), ["#204 Publish from the release branch", "Fix a typo in a comment"]);
});
