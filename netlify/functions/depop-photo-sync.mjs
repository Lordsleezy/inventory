import { json, corsHeaders, serviceClient, connectionAdminFromEvent } from "../lib/server.mjs";
import { wrapHandler, floorLog, asNetlifyFunction } from "../lib/floor-log.mjs";
import { withLock } from "../lib/bg-guard.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { syncDepopListingPhotos, countDepopPhotoCoverage } from "../lib/depop-photo-sync.mjs";

/**
 * Keep Depop listings.photo_ids fresh for exact sale-email matching.
 * Schedule: daily. Manual: owner/manager POST { manual: [{ sku, photo_ids }] } or { action: "sync" }.
 */

async function authorized(event) {
  if (isNetlifyScheduleEvent(event)) return true;
  const secret = process.env.MARKETPLACE_EMAIL_SECRET;
  const got = event.headers?.["x-marketplace-secret"] || event.headers?.["X-Marketplace-Secret"];
  if (secret && got === secret) return true;
  try {
    await connectionAdminFromEvent(event, ["owner", "manager"]);
    return true;
  } catch {
    return false;
  }
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (!(await authorized(event))) return json(401, { error: "unauthorized" });

  const sb = serviceClient();
  const { data: store } = await sb.from("stores").select("id").limit(1).single();
  if (!store) return json(500, { error: "store_missing" });

  let manual = [];
  if (event.httpMethod === "POST" && event.body) {
    try {
      const body = JSON.parse(event.body);
      if (Array.isArray(body?.manual)) manual = body.manual;
    } catch {
      /* ignore */
    }
  }

  try {
    const result = await withLock(
      "depop-photo-sync",
      120,
      () =>
        syncDepopListingPhotos(sb, {
          storeId: store.id,
          username: process.env.DEPOP_SHOP_USERNAME || "",
          manual,
        }),
      sb,
    );
    const coverage = await countDepopPhotoCoverage(sb, store.id);
    await floorLog({
      level: result.failed ? "warn" : "info",
      event: "depop.photo_sync",
      message: `updated=${result.updated} with_photos=${coverage.with_photos}/${coverage.listed} source=${result.source}`,
      detail: { ...result, coverage },
    });
    return json(200, { ...result, coverage });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { error: message.slice(0, 300) });
  }
}

export const invoke = wrapHandler("depop-photo-sync", handle);
export default asNetlifyFunction(invoke);
