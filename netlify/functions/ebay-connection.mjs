import { randomBytes } from "node:crypto";
import { json, corsHeaders } from "../lib/server.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { hopUrl } from "../lib/oauth-authorize.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";
import {
  disconnectEbay,
  ebayConnectionStatus,
  pollEbayOrders,
} from "../lib/ebay.mjs";
import { loadEbayAccount } from "../lib/ebay-accounts.mjs";
import { ensureBusinessPolicies } from "../lib/ebay-policies.mjs";
import {
  describeMigrationPlan,
  latestMigrationRun,
  migrationPrerequisites,
  runEbayMigration,
} from "../lib/ebay-migrate.mjs";

async function startConnect(ctx, event, role) {
  if (!ctx.userId) return json(400, { error: "Sign in from the admin portal to connect eBay." });
  if (role !== "selling" && role !== "orders_only") {
    return json(400, { error: "role must be selling or orders_only" });
  }
  const nonce = randomBytes(24).toString("hex");
  const ins = await ctx.sb.from("oauth_states").insert({
    store_id: ctx.storeId,
    user_id: ctx.userId,
    provider: "ebay",
    nonce,
    return_to: "https://admin.openboxindustries.com/?page=marketplaces",
    meta: { role },
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (ins.error) return json(500, { error: ins.error.message });
  return json(200, { ok: true, url: hopUrl(event, nonce), role });
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (ebayDisabled()) return json(503, { ok: false, error: "eBay integration is fully disabled (EBAY_DISABLED)." });
  let ctx;
  try {
    ctx = await portalAdminFromEvent(event);
  } catch (err) {
    return json(err.status || 401, { ok: false, error: err.message || "unauthorized" });
  }
  const storeId = ctx.storeId;
  const body = event.httpMethod === "GET" ? { action: "status" } : JSON.parse(event.body || "{}");
  const action = String(body.action || "status");

  if (action === "status") {
    const status = await ebayConnectionStatus(storeId);
    const pre = await migrationPrerequisites(storeId);
    const latest = await latestMigrationRun(storeId);
    return json(200, {
      ok: true,
      ...status,
      migration: {
        ready: pre.ready,
        blockers: pre.blockers,
        plan: describeMigrationPlan(),
        latest,
      },
    });
  }

  // Legacy "connect" → orders_only (keeps pgg124-5 path). Prefer connect_selling / connect_orders_only.
  if (action === "connect" || action === "connect_orders_only") {
    return startConnect(ctx, event, "orders_only");
  }
  if (action === "connect_selling") {
    return startConnect(ctx, event, "selling");
  }

  if (action === "disconnect") {
    await disconnectEbay(storeId, body.account_id || body.accountId || null);
    return json(200, { ok: true, ...(await ebayConnectionStatus(storeId)) });
  }

  if (action === "sync_now") {
    const status = await ebayConnectionStatus(storeId);
    if (!status.connected) return json(400, { ok: false, error: "eBay is not connected." });
    const accountId = body.account_id || body.accountId || null;
    const orders = accountId
      ? await pollEbayOrders(storeId, { accountId })
      : await Promise.all(
          (status.accounts || [])
            .filter((a) => a.status === "connected")
            .map((a) => pollEbayOrders(storeId, { accountId: a.id })),
        ).then((rows) => rows.flat());
    return json(200, { ok: true, orders, ...(await ebayConnectionStatus(storeId)) });
  }

  if (action === "ensure_policies") {
    const accountId = body.account_id || body.accountId;
    const account = accountId
      ? await loadEbayAccount(storeId, { id: accountId })
      : await loadEbayAccount(storeId, { role: "selling" });
    const policies = await ensureBusinessPolicies(account);
    return json(200, {
      ok: true,
      policies,
      ...(await ebayConnectionStatus(storeId)),
    });
  }

  if (action === "migration_dry_run") {
    const background = Boolean(body.background);
    if (background) {
      const base = process.env.URL || "https://inventoryobi.netlify.app";
      const res = await fetch(`${base}/.netlify/functions/ebay-migrate-background`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          store_id: storeId,
          mode: "dry_run",
          created_by: ctx.actor || ctx.userId || null,
          limit: body.limit != null ? Number(body.limit) : null,
        }),
      });
      if (!res.ok && res.status !== 202) {
        const text = await res.text();
        return json(502, { ok: false, error: `dry_run_worker_failed: ${text.slice(0, 300)}` });
      }
      return json(200, {
        ok: true,
        started: true,
        mode: "dry_run",
        message: "Dry-run started in the background. Refresh in a minute for results.",
      });
    }
    const result = await runEbayMigration(storeId, {
      mode: "dry_run",
      createdBy: ctx.actor || ctx.userId || null,
      limit: body.limit != null ? Number(body.limit) : null,
    });
    return json(200, { ok: result.ok !== false, ...result });
  }

  if (action === "migration_run") {
    const pre = await migrationPrerequisites(storeId);
    if (!pre.ready) {
      return json(400, {
        ok: false,
        error: "Migration is not ready.",
        blockers: pre.blockers,
      });
    }
    const base = process.env.URL || "https://inventoryobi.netlify.app";
    const res = await fetch(`${base}/.netlify/functions/ebay-migrate-background`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        store_id: storeId,
        mode: "live",
        created_by: ctx.actor || ctx.userId || null,
        limit: body.limit != null ? Number(body.limit) : null,
      }),
    });
    if (!res.ok && res.status !== 202) {
      const text = await res.text();
      return json(502, { ok: false, error: `migration_worker_failed: ${text.slice(0, 300)}` });
    }
    return json(200, {
      ok: true,
      started: true,
      mode: "live",
      message: "Migration started. Keep this page open and hit Refresh — results appear when the worker finishes.",
      blockers: pre.blockers,
    });
  }

  if (action === "migration_latest") {
    return json(200, { ok: true, latest: await latestMigrationRun(storeId) });
  }

  return json(400, { error: "unknown_action" });
}

export const invoke = wrapHandler("ebay-connection", handle);

export default asNetlifyFunction(invoke);
