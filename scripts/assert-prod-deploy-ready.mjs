#!/usr/bin/env node
/**
 * Production deploy guard. Refuses a stale tree, a Lambda-mode function,
 * a manifest mismatch, or an empty / reduced function bundle.
 *
 *   node scripts/assert-prod-deploy-ready.mjs
 *   node scripts/assert-prod-deploy-ready.mjs --skip-git
 *   node scripts/assert-prod-deploy-ready.mjs --artifact .netlify/v1/functions
 */
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { assessFunctions, assessGit, assessRuntime, listArtifactNames, loadManifest } from "./lib/deploy-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const skipGit = args.includes("--skip-git");
const artifactIdx = args.indexOf("--artifact");
const artifactDir = artifactIdx >= 0 ? path.resolve(args[artifactIdx + 1] || "") : null;

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: root, encoding: "utf8" }).trim();
}

function fail(error, detail = {}) {
  console.error(JSON.stringify({ ok: false, error, ...detail }, null, 2));
  process.exit(1);
}

if (!skipGit) {
  let fetched;
  try {
    git("fetch origin master --quiet");
    fetched = true;
  } catch (err) {
    fail("git_fetch_failed", { message: String(err?.message || err).slice(0, 300) });
  }
  if (fetched) {
    const gitReport = assessGit({
      branch: git("rev-parse --abbrev-ref HEAD"),
      head: git("rev-parse HEAD"),
      originMaster: git("rev-parse origin/master"),
      behind: Number(git("rev-list --count HEAD..origin/master") || "0"),
      ahead: Number(git("rev-list --count origin/master..HEAD") || "0"),
      dirty: Boolean(git("status --porcelain")),
    });
    if (!gitReport.ok) fail(gitReport.errors.join("; "), gitReport);
  }
}

const manifest = loadManifest(root);
const functionsDir = path.join(root, "netlify", "functions");
const files = readdirSync(functionsDir).filter((name) => name.endsWith(".mjs")).map((name) => name.replace(/\.mjs$/, ""));
const sources = {};
for (const name of files) sources[name] = readFileSync(path.join(functionsDir, `${name}.mjs`), "utf8");
const artifactNames = artifactDir ? listArtifactNames(artifactDir) : null;
const report = assessFunctions({ manifest, files, sources, artifactNames });
if (!report.ok) fail(report.errors.join("; "), { errors: report.errors });
if (artifactDir) {
  const runtimeFile = path.join(artifactDir, "manifest.json");
  if (!existsSync(runtimeFile)) fail("runtime_manifest_missing", { artifactDir });
  const runtime = assessRuntime(JSON.parse(readFileSync(runtimeFile, "utf8")));
  if (!runtime.ok) fail(runtime.errors.join("; "), runtime);
}

console.log(JSON.stringify({
  ok: true,
  functions: files.length,
  scheduled: Object.keys(manifest.schedules).length,
  artifact: artifactNames ? artifactNames.length : "not_checked",
}, null, 2));
