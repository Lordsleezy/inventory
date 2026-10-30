#!/usr/bin/env node
/**
 * Roll back the Floor functions site to an older ready deploy.
 * Dry-run unless --confirm is passed. Never invents a deploy id.
 *
 *   node scripts/rollback-prod-netlify.mjs --list
 *   node scripts/rollback-prod-netlify.mjs --deploy-id <id>
 *   node scripts/rollback-prod-netlify.mjs --deploy-id <id> --confirm
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessRollback } from "./lib/deploy-guard.mjs";
import { runNetlify } from "./lib/netlify-bin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const site = process.env.NETLIFY_SITE_ID || "458b95f4-4adb-4721-97bc-400f8bb97597";
const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
if (confirm && process.env.FLOOR_EMERGENCY_DEPLOY !== "yes-paul-approved") {
  console.error(JSON.stringify({
    ok: false,
    error: "manual_deploy_disabled",
    hint: "Production rollback is emergency recovery. Set FLOOR_EMERGENCY_DEPLOY=yes-paul-approved only with Paul's approval.",
  }, null, 2));
  process.exit(1);
}
const listOnly = args.includes("--list");
const idIdx = args.indexOf("--deploy-id");
const deployId = idIdx >= 0 ? args[idIdx + 1] : "";

function api(method, data) {
  const result = runNetlify(["api", method, "--data", JSON.stringify(data), "--cwd", root], { root, site });
  if (result.status !== 0) {
    console.error(JSON.stringify({ ok: false, error: "netlify_api_failed", method }));
    process.exit(result.status || 1);
  }
  return JSON.parse(result.stdout || "[]");
}

function summary(deploy) {
  return {
    id: deploy.id,
    state: deploy.state,
    context: deploy.context,
    created: deploy.created_at,
    commit: String(deploy.commit_ref || "").slice(0, 7),
    title: String(deploy.title || "").slice(0, 140),
    error: deploy.error_message,
  };
}

const deploys = api("listSiteDeploys", { site_id: site });
const rows = (Array.isArray(deploys) ? deploys : []).filter((d) => d.context === "production");
if (listOnly || !deployId) {
  console.log(JSON.stringify({ ok: true, dry_run: true, production: rows.slice(0, 10).map(summary) }, null, 2));
  process.exit(0);
}

const target = rows.find((d) => d.id === deployId);
if (!target) {
  console.error(JSON.stringify({ ok: false, error: "deploy_not_in_production_history", deployId }));
  process.exit(1);
}
const decision = assessRollback({ deploy: target, confirm });
if (!decision.ok) {
  console.error(JSON.stringify({ ok: false, error: decision.error, deploy: summary(target) }));
  process.exit(1);
}
if (!decision.restore) {
  console.log(JSON.stringify({
    ok: true,
    dry_run: true,
    would_restore: summary(target),
    hint: "Re-run with --confirm only after Paul approves. This does not upload a local folder.",
  }, null, 2));
  process.exit(0);
}

api("restoreSiteDeploy", { site_id: site, deploy_id: deployId });
console.log(JSON.stringify({ ok: true, restored: deployId }, null, 2));
