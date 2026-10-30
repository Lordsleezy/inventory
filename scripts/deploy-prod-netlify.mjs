#!/usr/bin/env node
/**
 * Production deploy for the Floor functions site (inventoryobi).
 *
 * Dry-run is the default. Production upload happens only with --confirm-prod,
 * and only after the guard has inspected a local build.
 *
 *   node scripts/deploy-prod-netlify.mjs
 *   node scripts/deploy-prod-netlify.mjs --confirm-prod
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessDeployCommand,
  assessEnv,
  assessFunctions,
  assessRuntime,
  findArtifactDir,
  healthFailures,
  listArtifactNames,
  loadManifest,
} from "./lib/deploy-guard.mjs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { runNetlify } from "./lib/netlify-bin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const confirm = process.argv.includes("--confirm-prod");
if (process.env.FLOOR_EMERGENCY_DEPLOY !== "yes-paul-approved") {
  fail("manual_deploy_disabled", {
    hint: "Production publishes from the release branch (daily 6:00 Pacific, or Release now). This script stays disabled unless FLOOR_EMERGENCY_DEPLOY=yes-paul-approved.",
  });
}
const site = process.env.NETLIFY_SITE_ID || "458b95f4-4adb-4721-97bc-400f8bb97597";
const baseUrl = process.env.FLOOR_FUNCTIONS_URL || "https://inventoryobi.netlify.app";

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: root, encoding: "utf8", shell: false, ...opts });
  return result;
}

function fail(error, detail = {}) {
  console.error(JSON.stringify({ ok: false, error, ...detail }, null, 2));
  process.exit(1);
}

const guard = run(process.execPath, [path.join(root, "scripts", "assert-prod-deploy-ready.mjs")]);
process.stdout.write(guard.stdout || "");
process.stderr.write(guard.stderr || "");
if (guard.status !== 0) fail("deploy_blocked_by_guard");

const build = runNetlify(["build", "--cwd", root, "--context", "production"], { root, site, stdio: "inherit" });
if (build.status !== 0) fail("build_failed");

const artifactDir = findArtifactDir(root);
if (!artifactDir) fail("artifact_dir_missing", { hint: "netlify build did not produce a functions directory" });
const artifactNames = listArtifactNames(artifactDir);
const manifest = loadManifest(root);
const functionsDir = path.join(root, "netlify", "functions");
const files = readdirSync(functionsDir).filter((name) => name.endsWith(".mjs")).map((name) => name.replace(/\.mjs$/, ""));
const sources = {};
for (const name of files) sources[name] = readFileSync(path.join(functionsDir, `${name}.mjs`), "utf8");
const functions = assessFunctions({ manifest, files, sources, artifactNames });
if (!functions.ok) fail("artifact_rejected", { errors: functions.errors, artifactDir });
const runtimeFile = path.join(artifactDir, "manifest.json");
if (!existsSync(runtimeFile)) fail("runtime_manifest_missing", { artifactDir });
const runtime = assessRuntime(JSON.parse(readFileSync(runtimeFile, "utf8")));
if (!runtime.ok) fail("legacy_runtime_rejected", runtime);

const envVars = loadEnvNames();
const envReport = assessEnv({
  vars: envVars,
  required: manifest.required_env,
  lambdaMode: functions.lambda.length > 0,
});
if (!envReport.ok) fail("env_rejected", { errors: envReport.errors, functions_scope_bytes: envReport.functions_scope_bytes });
const present = new Set(envVars.map((row) => row.key));
const restoreMissing = (manifest.restore_env || []).filter((key) => !present.has(key));
if (restoreMissing.length) envReport.warnings.push(`restore_before_relying_on:${restoreMissing.join(",")}`);

const command = assessDeployCommand({ dir: null, functions: artifactDir, noBuild: true, buildVerified: true });
if (!command.ok) fail(command.errors.join("; "));

if (!confirm) {
  console.log(JSON.stringify({
    ok: true,
    dry_run: true,
    functions: artifactNames.length,
    functions_scope_bytes: envReport.functions_scope_bytes,
    warnings: envReport.warnings,
    hint: "Re-run with --confirm-prod to publish this verified build. That still needs Paul's approval.",
  }, null, 2));
  process.exit(0);
}

const deploy = runNetlify(["deploy", "--prod", "--no-build", "--cwd", root, "--site", site, "--message", "guarded functions deploy"], {
  root,
  site,
  stdio: "inherit",
});
if (deploy.status !== 0) fail("deploy_command_failed");

const checked = await checkHealth(manifest.critical);
const failed = healthFailures(checked);
if (failed.length) {
  fail("post_deploy_health_failed", {
    failed,
    rollback: `node scripts/rollback-prod-netlify.mjs --list`,
  });
}
console.log(JSON.stringify({ ok: true, published: true, health: checked.length }, null, 2));

function loadEnvNames() {
  const result = runNetlify(["env:list", "--json", "--context", "production", "--scope", "functions", "--cwd", root, "--site", site], { root, site });
  if (result.status !== 0) fail("env_list_failed", { hint: "Could not read env var names. Deploy stopped." });
  const text = String(result.stdout || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) fail("env_list_unreadable");
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    fail("env_list_unreadable");
  }
  return Object.entries(data).map(([key, value]) => ({
    key,
    scopes: ["functions"],
    value_bytes: Buffer.byteLength(String(value ?? "")),
  }));
}

async function checkHealth(names) {
  const out = [];
  for (const name of names) {
    const url = `${baseUrl}/.netlify/functions/${name}`;
    try {
      const response = await fetch(url, { method: "OPTIONS" });
      out.push({ name, status: response.status });
    } catch (err) {
      out.push({ name, status: 0, error: String(err?.message || err).slice(0, 120) });
    }
  }
  return out;
}
