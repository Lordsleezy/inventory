import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessDeployCommand,
  assessEnv,
  assessFunctions,
  assessGit,
  assessRollback,
  assessRuntime,
  buildManifest,
  healthFailures,
  lambdaHandlerExports,
  loadManifest,
} from "./lib/deploy-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function manifest() {
  return loadManifest(root);
}

function sourcesFor(files) {
  const sources = {};
  for (const name of files) sources[name] = "export default function run() {}\n";
  return sources;
}

test("manifest matches the function files and schedules", () => {
  const built = buildManifest(root);
  const saved = manifest();
  assert.deepEqual(saved.functions, built.functions);
  assert.deepEqual(saved.schedules, built.schedules);
  assert.deepEqual(saved.critical, built.critical);
  assert.deepEqual(saved.required_env, built.required_env);
  assert.deepEqual(saved.restore_env, built.restore_env);
  assert.ok(saved.functions.length > 0);
  assert.ok(saved.schedules["ebay-sync"]);
  assert.ok(saved.schedules["enrich-models"]);
  assert.ok(saved.critical.includes("web-checkout"));
  assert.equal(saved.functions.includes("dropship-hunt"), false);
});

test("no function exports a Lambda handler", () => {
  const dir = path.join(root, "netlify", "functions");
  const files = readdirSync(dir).filter((name) => name.endsWith(".mjs"));
  const lambda = [];
  for (const file of files) {
    const source = readFileSync(path.join(dir, file), "utf8");
    if (lambdaHandlerExports(source) || !/export default /.test(source)) lambda.push(file);
  }
  assert.deepEqual(lambda, []);
});

test("empty artifact fails closed", () => {
  const saved = manifest();
  const report = assessFunctions({
    manifest: saved,
    files: saved.functions,
    sources: sourcesFor(saved.functions),
    artifactNames: [],
  });
  assert.equal(report.ok, false);
  assert.ok(report.errors.includes("artifact_empty"));
});

test("missing critical function fails", () => {
  const saved = manifest();
  const files = saved.functions.filter((name) => name !== "ebay-sync");
  const report = assessFunctions({
    manifest: saved,
    files,
    sources: sourcesFor(files),
  });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.startsWith("source_missing:ebay-sync")));
  assert.ok(report.errors.includes("critical_missing:ebay-sync"));
});

test("a handler export fails", () => {
  const saved = manifest();
  const sources = sourcesFor(saved.functions);
  sources["ebay-sync"] = "export const handler = async () => ({ statusCode: 200 });\n";
  const report = assessFunctions({ manifest: saved, files: saved.functions, sources });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.includes("lambda_handler_export:ebay-sync")));
});

test("fewer artifact functions than the manifest fails", () => {
  const saved = manifest();
  const report = assessFunctions({
    manifest: saved,
    files: saved.functions,
    sources: sourcesFor(saved.functions),
    artifactNames: saved.functions.slice(1),
  });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.startsWith("function_count_dropped:")));
});

test("lambda mode over 4KB fails and modern runtime does not", () => {
  const vars = [{ key: "SECRET", scopes: ["functions"], value_bytes: 5000 }];
  const legacy = assessEnv({ vars, required: [], lambdaMode: true });
  const modern = assessEnv({ vars, required: [], lambdaMode: false });
  assert.equal(legacy.ok, false);
  assert.ok(legacy.errors[0].startsWith("lambda_env_over_4kb:"));
  assert.equal(modern.ok, true);
  assert.ok(modern.functions_scope_bytes > 4096);
});

test("missing or builds-only required env fails without printing a value", () => {
  const missing = assessEnv({
    vars: [{ key: "SUPABASE_URL", scopes: ["builds"], value_bytes: 20 }],
    required: ["SUPABASE_URL", "CONNECTIONS_KEY"],
    lambdaMode: false,
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.includes("env_not_in_functions_scope:SUPABASE_URL"));
  assert.ok(missing.errors.includes("missing_env:CONNECTIONS_KEY"));
  assert.equal(JSON.stringify(missing).includes("secret-value"), false);
});

test("git must be a clean origin/master", () => {
  const clean = assessGit({ branch: "master", head: "abc", originMaster: "abc", behind: 0, ahead: 0, dirty: false });
  const dirty = assessGit({ branch: "master", head: "abc", originMaster: "abc", behind: 0, ahead: 0, dirty: true });
  const branch = assessGit({ branch: "fix/netlify-functions-runtime", head: "abc", originMaster: "def", behind: 0, ahead: 1, dirty: false });
  assert.equal(clean.ok, true);
  assert.deepEqual(dirty.errors, ["dirty_worktree"]);
  assert.ok(branch.errors.includes("not_on_master"));
  assert.ok(branch.errors.includes("head_not_origin_master"));
});

test("deploying a directory without functions is rejected", () => {
  const bad = assessDeployCommand({ dir: "netlify/public", functions: null, noBuild: true, buildVerified: false });
  const good = assessDeployCommand({ dir: null, functions: ".netlify/v1/functions", noBuild: true, buildVerified: true });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.includes("dir_without_functions"));
  assert.equal(good.ok, true);
});

test("rollback stays a dry-run and refuses an empty function deploy", () => {
  const ready = { state: "ready", error_message: null, function_count: 64 };
  assert.deepEqual(assessRollback({ deploy: ready, confirm: false }), { ok: true, dry_run: true });
  assert.equal(assessRollback({ deploy: ready, confirm: true }).restore, true);
  assert.equal(assessRollback({ deploy: { state: "ready", function_count: 0 }, confirm: true }).error, "refusing_zero_function_deploy");
  assert.equal(assessRollback({ deploy: { state: "ready", available_functions: [] }, confirm: true }).error, "refusing_zero_function_deploy");
  assert.equal(assessRollback({ deploy: { state: "error", error_message: "failed" }, confirm: true }).error, "refusing_unready_deploy");
});

test("a legacy runtime in the build manifest fails", () => {
  const modern = assessRuntime({ functions: [{ name: "ebay-sync", buildData: { runtimeAPIVersion: 2 } }] });
  const legacy = assessRuntime({ functions: [{ name: "ebay-sync", buildData: { runtimeAPIVersion: 1 } }] });
  const empty = assessRuntime({ functions: [] });
  assert.equal(modern.ok, true);
  assert.equal(legacy.ok, false);
  assert.ok(legacy.errors[0].startsWith("legacy_runtime:ebay-sync"));
  assert.equal(empty.ok, false);
});

test("health check fails on a missing function", () => {
  const failed = healthFailures([
    { name: "ebay-sync", status: 200 },
    { name: "web-checkout", status: 404 },
  ]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].name, "web-checkout");
});
