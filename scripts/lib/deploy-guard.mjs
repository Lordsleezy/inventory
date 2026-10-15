/**
 * Pure checks for production Netlify deploys. No network and no secret values.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const LAMBDA_LIMIT_BYTES = 4096;

const LAMBDA_EXPORT = /export\s+(?:async\s+)?function\s+handler\b|export\s+const\s+handler\b|exports\.handler\s*=/;

export function lambdaHandlerExports(source) {
  return LAMBDA_EXPORT.test(source);
}

export function parseTomlSchedules(toml) {
  const schedules = {};
  let current = null;
  for (const line of toml.split(/\r?\n/)) {
    const header = line.match(/^\[functions\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/);
    if (header) {
      current = header[1] || header[2];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    const sched = line.match(/^\s*schedule\s*=\s*"([^"]+)"\s*$/);
    if (sched && current) schedules[current] = sched[1];
  }
  return schedules;
}

export function inlineSchedule(source) {
  if (!/export\s+const\s+config\b/.test(source)) return null;
  const match = source.match(/schedule\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

export function listFunctionFiles(functionsDir) {
  return readdirSync(functionsDir)
    .filter((name) => name.endsWith(".mjs") || name.endsWith(".js"))
    .map((name) => name.replace(/\.(mjs|js)$/, ""))
    .sort();
}

export function buildManifest(root) {
  const functionsDir = path.join(root, "netlify", "functions");
  const names = listFunctionFiles(functionsDir);
  const toml = readFileSync(path.join(root, "netlify.toml"), "utf8");
  const schedules = parseTomlSchedules(toml);
  for (const name of names) {
    const source = readFileSync(path.join(functionsDir, `${name}.mjs`), "utf8");
    const inline = inlineSchedule(source);
    if (inline && !schedules[name]) schedules[name] = inline;
  }
  const critical = [...new Set([...Object.keys(schedules), "web-checkout", "oauth-callback", "square-mobile-token"])].sort();
  return {
    functions: names,
    schedules,
    critical,
    required_env: [
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE",
      "SUPABASE_ANON_KEY",
      "CONNECTIONS_KEY",
      "EBAY_CLIENT_ID",
      "EBAY_CLIENT_SECRET",
      "EBAY_NOTIFICATION_ENDPOINT",
      "EBAY_NOTIFICATION_TOKEN",
      "GMAIL_SMTP_USER",
      "GMAIL_SMTP_APP_PASSWORD",
      "SQUARE_APPLICATION_ID",
      "SQUARE_APPLICATION_SECRET",
      "OAUTH_REDIRECT_URI",
      "AMAZON_LWA_CLIENT_ID",
      "AMAZON_LWA_CLIENT_SECRET",
    ],
    // Missing these breaks one flow. They do not block a deploy of the rest of the store.
    restore_env: [
      "EBAY_DELETION_ENDPOINT_URL",
      "EBAY_DELETION_VERIFICATION_TOKEN",
      "AMAZON_APPLICATION_ID",
    ],
  };
}

export function loadManifest(root) {
  return JSON.parse(readFileSync(path.join(root, "scripts", "function-manifest.json"), "utf8"));
}

export function diffNames(expected, actual) {
  const want = new Set(expected);
  const got = new Set(actual);
  return {
    missing: [...want].filter((name) => !got.has(name)).sort(),
    extra: [...got].filter((name) => !want.has(name)).sort(),
  };
}

export function assessFunctions({ manifest, files, sources, artifactNames }) {
  const errors = [];
  if (!manifest?.functions?.length) errors.push("manifest_empty");
  if (!files?.length) errors.push("function_directory_empty");
  const fileDiff = diffNames(manifest.functions || [], files || []);
  if (fileDiff.missing.length) errors.push(`source_missing:${fileDiff.missing.join(",")}`);
  if (fileDiff.extra.length) errors.push(`source_not_in_manifest:${fileDiff.extra.join(",")}`);
  const lambda = [];
  for (const [name, source] of Object.entries(sources || {})) {
    if (lambdaHandlerExports(source)) lambda.push(name);
  }
  if (lambda.length) errors.push(`lambda_handler_export:${lambda.sort().join(",")}`);
  for (const [name, cron] of Object.entries(manifest.schedules || {})) {
    if (!cron) errors.push(`schedule_blank:${name}`);
    if (!(manifest.functions || []).includes(name)) errors.push(`schedule_without_function:${name}`);
  }
  for (const name of manifest.critical || []) {
    if (!(files || []).includes(name)) errors.push(`critical_missing:${name}`);
  }
  if (artifactNames) {
    if (artifactNames.length === 0) errors.push("artifact_empty");
    const artifactDiff = diffNames(manifest.functions || [], artifactNames);
    if (artifactDiff.missing.length) errors.push(`artifact_missing:${artifactDiff.missing.join(",")}`);
    if (artifactDiff.extra.length) errors.push(`artifact_extra:${artifactDiff.extra.join(",")}`);
    if (artifactNames.length < (manifest.functions || []).length) {
      errors.push(`function_count_dropped:${artifactNames.length}<${manifest.functions.length}`);
    }
  }
  return { ok: errors.length === 0, errors, lambda };
}

export function functionsScopeBytes(vars) {
  let total = 0;
  for (const row of vars || []) {
    if (!inFunctionsScope(row.scopes)) continue;
    total += Buffer.byteLength(String(row.key || "")) + (Number(row.value_bytes) || 0);
  }
  return total;
}

export function inFunctionsScope(scopes) {
  const list = Array.isArray(scopes) ? scopes : [];
  if (list.length === 0) return true;
  return list.some((scope) => /function|all|runtime/i.test(String(scope)));
}

export function assessEnv({ vars, required, lambdaMode }) {
  const errors = [];
  const warnings = [];
  const byKey = new Map((vars || []).map((row) => [row.key, row]));
  for (const key of required || []) {
    const row = byKey.get(key);
    if (!row) {
      errors.push(`missing_env:${key}`);
      continue;
    }
    if (!inFunctionsScope(row.scopes)) errors.push(`env_not_in_functions_scope:${key}`);
    if ((Number(row.value_bytes) || 0) === 0) errors.push(`env_empty:${key}`);
  }
  const fnBytes = functionsScopeBytes(vars);
  if (lambdaMode && fnBytes > LAMBDA_LIMIT_BYTES) {
    errors.push(`lambda_env_over_4kb:${fnBytes}`);
  }
  if (!lambdaMode && fnBytes > LAMBDA_LIMIT_BYTES) {
    warnings.push(`functions_env_bytes:${fnBytes}`);
  }
  return { ok: errors.length === 0, errors, warnings, functions_scope_bytes: fnBytes };
}

export function assessGit({ branch, head, originMaster, behind, ahead, dirty }) {
  const errors = [];
  const onMaster = branch === "master" || branch === "main";
  const detached = branch === "HEAD" && head === originMaster;
  if (!onMaster && !detached) errors.push("not_on_master");
  if (behind > 0) errors.push("behind_origin_master");
  if (head !== originMaster) errors.push("head_not_origin_master");
  if (dirty) errors.push("dirty_worktree");
  return { ok: errors.length === 0, errors };
}

export function assessDeployCommand({ dir, functions, noBuild, buildVerified }) {
  const errors = [];
  if (dir && !functions) errors.push("dir_without_functions");
  if (noBuild && !buildVerified) errors.push("no_build_without_verified_artifact");
  return { ok: errors.length === 0, errors };
}

export function listArtifactNames(dir) {
  if (!dir) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory() || entry.endsWith(".zip")) out.push(entry.replace(/\.zip$/, ""));
  }
  return out.sort();
}

export function findArtifactDir(root) {
  const candidates = [
    ".netlify/v1/functions",
    ".netlify/functions",
    ".netlify/functions-internal",
  ];
  for (const rel of candidates) {
    const full = path.join(root, rel);
    try {
      if (statSync(full).isDirectory() && readdirSync(full).length > 0) return full;
    } catch {
      /* not built */
    }
  }
  return null;
}

export function assessRuntime(built) {
  const functions = built?.functions || [];
  const errors = [];
  if (!functions.length) errors.push("runtime_manifest_empty");
  const legacy = functions.filter((fn) => fn?.buildData?.runtimeAPIVersion !== 2).map((fn) => fn.name);
  if (legacy.length) errors.push(`legacy_runtime:${legacy.join(",")}`);
  return { ok: errors.length === 0, errors, count: functions.length };
}

export function healthFailures(results) {
  return (results || []).filter((row) => row.status === 404 || row.status === 0 || row.status >= 500 || row.error);
}

export function assessRollback({ deploy, confirm }) {
  if (!deploy) return { ok: false, error: "missing_deploy" };
  if (deploy.state !== "ready" || deploy.error_message) return { ok: false, error: "refusing_unready_deploy" };
  const count = Array.isArray(deploy.available_functions) ? deploy.available_functions.length : deploy.function_count;
  if (count === 0) return { ok: false, error: "refusing_zero_function_deploy" };
  if (!confirm) return { ok: true, dry_run: true };
  return { ok: true, restore: true };
}
