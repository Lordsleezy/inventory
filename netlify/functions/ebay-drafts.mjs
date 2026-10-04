import { randomBytes } from "node:crypto";
import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { hopUrl } from "../lib/oauth-authorize.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import {
  endDraft,
  listDraftPage,
  lookupDraftMarket,
  loadEbaySettings,
  prepareDraft,
  pushDrafts,
  resolveBusinessPolicies,
  saveBox,
  saveDraft,
  saveEbaySettings,
} from "../lib/ebay-drafts.mjs";
import { backfillStatus, startBackfill } from "../lib/ebay-backfill.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" });
  let ctx;
  try {
    const body = JSON.parse(event.body || "{}");
    ctx = await portalAdminFromEvent(event, body.store_id);
    const { storeId } = ctx;
    const action = body.action || "list";
    if (action === "list" || action === "refresh") {
      const [page, backfill] = await Promise.all([listDraftPage(storeId, { refresh: action === "refresh" }), backfillStatus(storeId)]);
      return json(200, { ok: true, ...page, backfill });
    }
    if (action === "backfill_status") return json(200, { ok: true, backfill: await backfillStatus(storeId) });
    if (action === "start_backfill") return json(200, { ok: true, backfill: await startBackfill(storeId) });
    if (action === "prepare") return json(200, { ok: true, draft: await prepareDraft(storeId, String(body.sku || "")) });
    if (action === "market") return json(200, { ok: true, market: await lookupDraftMarket(storeId, String(body.sku || "")) });
    if (action === "save") return json(200, { ok: true, draft: await saveDraft(storeId, String(body.sku || ""), body.fields || {}) });
    if (action === "save_box") return json(200, { ok: true, draft: await saveBox(storeId, String(body.sku || ""), body.box || {}) });
    if (action === "push") return json(200, { ok: true, results: await pushDrafts(storeId, Array.isArray(body.skus) ? body.skus : []) });
    if (action === "end") return json(200, { ok: true, ...(await endDraft(storeId, String(body.sku || ""))) });
    if (action === "save_settings") {
      const settings = await saveEbaySettings(storeId, body.settings || {});
      return json(200, { ok: true, settings });
    }
    if (action === "check_policies") {
      let policyError = null;
      try { await resolveBusinessPolicies(storeId, { force: true }); }
      catch (err) { policyError = err instanceof Error ? err.message : String(err); }
      const settings = await loadEbaySettings(storeId);
      return json(200, { ok: true, policies: settings.policyStatus || { ok: false, missing: policyError ? [policyError] : [] }, error: policyError });
    }
    if (action === "connect") {
      if (!ctx.userId) return json(400, { error: "Sign in from the admin portal to connect eBay." });
      const sb = serviceClient();
      const nonce = randomBytes(24).toString("hex");
      const ins = await sb.from("oauth_states").insert({
        store_id: storeId,
        user_id: ctx.userId,
        provider: "ebay",
        nonce,
        return_to: "https://admin.openboxindustries.com/?ebay=1",
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      if (ins.error) return json(500, { error: ins.error.message });
      return json(200, { ok: true, url: hopUrl(event, nonce) });
    }
    return json(400, { error: "unknown_action" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(err.status || 400, { ok: false, error: message });
  }
}

export const handler = wrapHandler("ebay-drafts", handle);
