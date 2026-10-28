/**
 * UPC lookup HTTP endpoint (portal admins and active store staff; read-only — never lists).
 *
 * POST { action: "lookup", upc, force?, compare_upcitemdb?, store_id? }
 * POST { action: "batch_status", upcs?: string[] }   → cache coverage for the given codes (no external calls)
 */
import { json, optionsOk } from "../lib/server.mjs";
import { receiveAccessFromEvent } from "../lib/receive-auth.mjs";
import { netlifyHandler, floorLog } from "../lib/floor-log.mjs";
import { lookupUpc } from "../lib/upc-lookup.mjs";
import { normalizeGtin } from "../lib/gtin-normalize.mjs";

const BATCH_MAX = 100;

async function actions(event, ctx) {
  const body = JSON.parse(event.body || "{}");
  const action = String(body.action || "lookup");

  if (action === "lookup") {
    const upc = String(body.upc ?? "").trim();
    if (!upc) return json(400, { ok: false, error: "upc_required" });
    try {
      const result = await lookupUpc(ctx.storeId, upc, {
        force: body.force === true,
        compareUpcitemdb: body.compare_upcitemdb === true,
      });
      return json(200, { ok: true, ...result });
    } catch (err) {
      await floorLog({
        level: "error",
        event: "upc_lookup.fail",
        message: err.message || "lookup_failed",
        storeId: ctx.storeId,
        detail: { upc, code: err.code || null, status: err.status || null },
      });
      if (err.code === "invalid_gtin") return json(400, { ok: false, error: "invalid_gtin", message: err.message });
      throw err;
    }
  }

  if (action === "batch_status") {
    const raw = Array.isArray(body.upcs) ? body.upcs.slice(0, BATCH_MAX) : [];
    const parsed = raw.map((r) => ({ input: String(r), g: normalizeGtin(r) }));
    const valid = [...new Set(parsed.filter((p) => p.g.ok).map((p) => p.g.gtin14))];
    const cached = new Map();
    if (valid.length) {
      const { data, error } = await ctx.sb.from("upc_lookup_cache").select("gtin14, looked_up_at, payload").in("gtin14", valid);
      if (error) return json(500, { ok: false, error: error.message });
      for (const r of data || []) cached.set(r.gtin14, r);
    }
    return json(200, {
      ok: true,
      results: parsed.map(({ input, g }) => {
        if (!g.ok) return { input, valid: false, issue: g.issue };
        const hit = cached.get(g.gtin14);
        return {
          input,
          valid: true,
          gtin14: g.gtin14,
          cached: Boolean(hit),
          looked_up_at: hit?.looked_up_at || null,
          title: hit?.payload?.merged?.title || null,
          asin: hit?.payload?.merged?.asin || null,
          retail_cents: hit?.payload?.merged?.retail_cents ?? null,
        };
      }),
    });
  }

  return json(400, { ok: false, error: "unknown_action" });
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return optionsOk();
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  try {
    const preview = JSON.parse(event.body || "{}");
    const ctx = await receiveAccessFromEvent(event, preview.store_id);
    return await actions(event, ctx);
  } catch (err) {
    const status = err.status || 500;
    const error =
      status === 401
        ? "not_logged_in"
        : status === 403
          ? "not_authorized"
          : err.message || "error";
    return json(status, { ok: false, error, message: err.message || error });
  }
}

export default netlifyHandler("upc-lookup", handle);
