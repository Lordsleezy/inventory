#!/usr/bin/env node
/**
 * Promote origin/master onto origin/release.
 * Live migrations run before the branch moves. Release is fast-forwarded only.
 *
 *   RELEASE_REASON=schedule node scripts/release/promote.mjs
 *   RELEASE_REASON=manual   node scripts/release/promote.mjs
 */
import { spawnSync } from "node:child_process";
import { git, gitOut } from "./git.mjs";
import { sendReleaseMail } from "./mail.mjs";
import { assessChecks, classifyDeploy, migrationsFromPushOutput, prTitlesFromLog, redact, REQUIRED_CHECK_NAMES } from "./plan.mjs";
import { isReleaseWindow } from "./schedule.mjs";
import { MASTER_BRANCH, PREVIOUS_TAG, PROJECT_REF, RELEASE_BRANCH, SITES, sitesForFiles } from "./sites.mjs";

const reason = process.env.RELEASE_REASON || "manual";
const repo = process.env.GITHUB_REPOSITORY || "Lordsleezy/inventory";
const CI_WAIT_MS = 40 * 60 * 1000;
const NETLIFY_WAIT_MS = 20 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(cmd, args, { allowFailure = false } = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${redact(output).slice(0, 4000)}`);
  }
  return { status: result.status ?? 1, output };
}

async function fail(subject, text) {
  console.error(subject);
  console.error(text);
  try {
    await sendReleaseMail({ subject, text });
  } catch (err) {
    console.error(`email failed: ${redact(err?.message || err)}`);
  }
  process.exit(1);
}

function ghJson(path) {
  const result = run("gh", ["api", path]);
  return JSON.parse(result.output);
}

async function checksFor(sha) {
  const runs = [];
  for (let page = 1; page <= 5; page += 1) {
    const data = ghJson(`repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`);
    const batch = data.check_runs || [];
    runs.push(...batch);
    if (batch.length < 100) break;
  }
  return assessChecks(runs, REQUIRED_CHECK_NAMES);
}

async function waitForChecks(sha) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < CI_WAIT_MS) {
    last = await checksFor(sha);
    if (last.ok || last.failed.length) return last;
    console.log(`CI not green yet for ${sha.slice(0, 7)}: pending=${last.pending.join(",") || "-"} missing=${last.missing.join(",") || "-"}`);
    await sleep(30_000);
  }
  return last;
}

function changedFiles(from, to) {
  const out = gitOut(["diff", "--name-only", from, to]);
  return out ? out.split(/\n/).filter(Boolean) : [];
}

function titles(from, to) {
  const log = gitOut(["log", "--format=%s%n%b%n---", `${from}..${to}`]);
  return prTitlesFromLog(log);
}

async function pushMigrations() {
  const args = ["supabase", "db", "push", "--project-ref", PROJECT_REF, "--yes", "--skip-vault"];
  const dry = run("npx", ["--no-install", ...args, "--dry-run"]);
  console.log(redact(dry.output));
  const planned = migrationsFromPushOutput(dry.output);
  const apply = run("npx", ["--no-install", ...args]);
  console.log(redact(apply.output));
  const applied = migrationsFromPushOutput(apply.output);
  return applied.length ? applied : planned;
}

function fastForward(sha) {
  const pushed = git(["push", "origin", `${sha}:refs/heads/${RELEASE_BRANCH}`], { allowFailure: true });
  if (pushed.status !== 0) {
    throw new Error(`fast-forward of ${RELEASE_BRANCH} refused:\n${redact(pushed.stderr || pushed.stdout)}`);
  }
}

function pointPreviousTag(sha) {
  const pushed = git(["push", "origin", `${sha}:refs/tags/${PREVIOUS_TAG}`, "--force"], { allowFailure: true });
  if (pushed.status !== 0) {
    throw new Error(`could not record previous release tag:\n${redact(pushed.stderr || pushed.stdout)}`);
  }
}

async function netlifyDeploys(siteId) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new Error("NETLIFY_AUTH_TOKEN is not set");
  const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys?per_page=20`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`netlify deploys ${res.status}`);
  return res.json();
}

function matchingDeploy(deploys, sha, notBeforeMs) {
  return (deploys || []).find((deploy) => {
    if (deploy.context && deploy.context !== "production") return false;
    if (!String(deploy.commit_ref || "").startsWith(sha)) return false;
    const created = Date.parse(deploy.created_at || 0);
    return !notBeforeMs || created >= notBeforeMs - 15_000;
  });
}

async function waitForSites(sha, expected, startedMs) {
  const deadline = Date.now() + NETLIFY_WAIT_MS;
  const results = Object.fromEntries(SITES.map((site) => [site.name, { site, state: "pending" }]));
  while (Date.now() < deadline) {
    let waiting = false;
    for (const site of SITES) {
      const deploys = await netlifyDeploys(site.id);
      const deploy = matchingDeploy(deploys, sha, startedMs);
      const wanted = expected.some((item) => item.name === site.name);
      const kind = classifyDeploy(deploy);
      if (!wanted && !deploy) {
        results[site.name] = { site, state: "skipped", deploy: null };
        continue;
      }
      results[site.name] = { site, state: kind, deploy, wanted };
      if (kind === "pending") waiting = true;
    }
    if (!waiting && SITES.every((site) => results[site.name].state !== "pending")) return results;
    await sleep(20_000);
  }
  return results;
}

async function main() {
  if (reason === "schedule" && !isReleaseWindow(new Date())) {
    console.log("Skipping. This UTC wake-up is not 6:00 America/Los_Angeles.");
    return;
  }

  git(["fetch", "origin", MASTER_BRANCH]);
  git(["fetch", "origin", RELEASE_BRANCH], { allowFailure: true });
  const releaseRef = git(["rev-parse", "--verify", `origin/${RELEASE_BRANCH}`], { allowFailure: true });
  if (releaseRef.status !== 0) {
    await fail(
      "[Floor] Release aborted: release branch missing",
      "origin/release does not exist, so production was not moved and no migrations were applied.",
    );
  }
  const releaseSha = releaseRef.stdout.trim();
  const masterSha = gitOut(["rev-parse", `origin/${MASTER_BRANCH}`]);
  console.log(`master ${masterSha} release ${releaseSha}`);

  if (masterSha === releaseSha) {
    console.log("master and release are the same commit. Nothing to release.");
    return;
  }

  const ancestor = git(["merge-base", "--is-ancestor", releaseSha, masterSha], { allowFailure: true });
  if (ancestor.status !== 0) {
    await fail(
      "[Floor] Release aborted: release has diverged",
      [
        "release is not an ancestor of master, so this job will not force-push.",
        `release ${releaseSha}`,
        `master  ${masterSha}`,
        "Fix the branches, then run Release now.",
      ].join("\n"),
    );
  }

  const checks = await waitForChecks(masterSha);
  if (!checks?.ok) {
    await fail(
      "[Floor] Release skipped: CI is not green",
      [
        `master ${masterSha} was not released. release is still ${releaseSha}.`,
        `missing: ${(checks?.missing || []).join(", ") || "none"}`,
        `pending: ${(checks?.pending || []).join(", ") || "none"}`,
        `failed: ${(checks?.failed || []).join(", ") || "none"}`,
        "No migrations were applied and release was not moved.",
      ].join("\n"),
    );
  }

  let migrations = [];
  try {
    migrations = await pushMigrations();
  } catch (err) {
    await fail(
      "[Floor] Release aborted: migration failed",
      [
        "Live migration failed. release was not moved and Netlify was not deployed.",
        `master ${masterSha}`,
        `release stayed at ${releaseSha}`,
        "",
        redact(err?.message || err),
      ].join("\n"),
    );
  }

  const files = changedFiles(releaseSha, masterSha);
  const expected = sitesForFiles(files);
  const notes = titles(releaseSha, masterSha);
  pointPreviousTag(releaseSha);
  const pushedAt = Date.now();
  try {
    fastForward(masterSha);
  } catch (err) {
    await fail(
      "[Floor] Release aborted: fast-forward failed",
      [
        "Migrations may already be applied. release was not moved.",
        `previous release tag points at ${releaseSha}`,
        redact(err?.message || err),
      ].join("\n"),
    );
  }

  let siteResults;
  try {
    siteResults = await waitForSites(masterSha, expected, pushedAt);
  } catch (err) {
    await fail(
      "[Floor] Release moved, Netlify status unknown",
      [
        `release is now ${masterSha}.`,
        "Use Roll back release if production looks wrong. Migrations are not rolled back automatically.",
        redact(err?.message || err),
      ].join("\n"),
    );
  }

  const lines = SITES.map((site) => {
    const row = siteResults[site.name];
    const wanted = expected.some((item) => item.name === site.name);
    return `${site.label}: ${row.state}${wanted ? "" : " (paths unchanged)"}`;
  });
  const bad = SITES.filter((site) => {
    const row = siteResults[site.name];
    const wanted = expected.some((item) => item.name === site.name);
    if (wanted) return row.state !== "deployed";
    return row.state === "failed" || row.state === "pending";
  });
  const summary = [
    `Release ${releaseSha.slice(0, 7)} → ${masterSha.slice(0, 7)} (${reason}).`,
    "",
    "Changes:",
    ...(notes.length ? notes.map((title) => `- ${title}`) : ["- (no pull request titles)"]),
    "",
    "Migrations applied:",
    ...(migrations.length ? migrations.map((name) => `- ${name}`) : ["- none"]),
    "",
    "Sites:",
    ...lines.map((line) => `- ${line}`),
  ].join("\n");

  if (bad.length) {
    await fail("[Floor] Release failed: Netlify deploy did not succeed", `${summary}\n\nrelease points at the new commit. Roll back release if you need the previous build. Migrations are not rolled back automatically.`);
  }

  await sendReleaseMail({ subject: `[Floor] Released ${masterSha.slice(0, 7)}`, text: summary });
  console.log(summary);
}

main().catch(async (err) => {
  await fail("[Floor] Release aborted", redact(err?.stack || err?.message || err));
});
