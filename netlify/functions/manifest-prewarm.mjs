/**
 * Admin-triggered Costco/manifest UPC pre-warm.
 * POST { action: "status" } | { action: "start", csv_path?, limit?, offset?, force? }
 *
 * Heavy work runs via manifest-prewarm-background. Never lists to channels.
 */
import { json, optionsOk } from "../lib/server.mjs";
import { receiveAccessFromEvent } from "../lib/receive-auth.mjs";
import { netlifyHandler } from "../lib/floor-log.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return optionsOk();
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  const body = JSON.parse(event.body || "{}");
  const ctx = await receiveAccessFromEvent(event, body.store_id);
  if (!ctx.isAdmin) return json(403, { ok: false, error: "admin_required" });

  if (body.action === "status") {
    const { data, error } = await ctx.sb
      .from("upc_lookup_cache")
      .select("gtin14, looked_up_at, payload")
      .contains("payload", { prewarm: {} })
      .order("looked_up_at", { ascending: false })
      .limit(20);
    if (error) return json(500, { ok: false, error: error.message });
    return json(200, { ok: true, recent: data || [] });
  }

  // Kick background worker when deployed; local agents use scripts/prewarm-costco-manifest.mjs.
  const site = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  if (site) {
    fetch(`${site}/.netlify/functions/manifest-prewarm-background`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: event.headers.authorization || event.headers.Authorization || "",
      },
      body: JSON.stringify({
        store_id: ctx.storeId,
        force: body.force === true,
        limit: body.limit || 0,
        offset: body.offset || 0,
        lines: Array.isArray(body.lines) ? body.lines : undefined,
        csv_text: typeof body.csv_text === "string" ? body.csv_text : undefined,
      }),
    }).catch(() => {});
  }
  return json(202, {
    ok: true,
    started: true,
    hint: "Background prewarm accepted when deployed; otherwise run scripts/prewarm-costco-manifest.mjs",
  });
}

export default netlifyHandler("manifest-prewarm", handle);
