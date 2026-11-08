import { serviceClient } from "../server.mjs";
import { hunt, DEFAULT_HUNTER } from "./hunter.mjs";

/** Run hunter over US catalog rows and upsert pending picks. */
export async function runHunter(storeId, opts = {}) {
  const sb = serviceClient();
  const { data: settingsRow } = await sb.from("dropship_settings").select("*").eq("store_id", storeId).maybeSingle();
  const settings = { ...DEFAULT_HUNTER, ...(settingsRow?.settings || {}) };
  const channels = [];
  if (settingsRow?.ebay_channel_on || opts.forceEbay) channels.push("ebay");
  if (settingsRow?.website_channel_on || opts.forceWebsite) channels.push("website");
  if (!channels.length) channels.push("ebay"); // still score for review even if channel off

  const limit = Math.min(2000, Number(opts.limit) || 500);
  const { data: items } = await sb
    .from("supplier_catalog_items")
    .select("*")
    .eq("store_id", storeId)
    .eq("ships_from_us", true)
    .order("landed_cents", { ascending: true })
    .limit(limit);

  const ranked = hunt(items || [], channels, settings).slice(0, Number(opts.top || 100));
  let upserted = 0;
  for (const row of ranked) {
    const { error } = await sb.from("dropship_picks").upsert(
      {
        store_id: storeId,
        catalog_item_id: row.item.id,
        status: "pending",
        suggested_price_cents: row.suggested_price_cents,
        channel: row.channel,
        landed_cents: row.landed_cents,
        fee_cents: row.fee_cents,
        reserve_cents: row.reserve_cents,
        profit_cents: row.profit_cents,
        margin_bps: row.margin_bps,
        ships_in_days: row.ships_in_days,
        reason: row.reason,
        rank_score: row.rank_score,
      },
      { onConflict: "store_id,catalog_item_id,channel" },
    );
    if (!error) upserted += 1;
  }
  return { scanned: (items || []).length, picks: ranked.length, upserted };
}

export async function decidePick(storeId, pickId, decision, userId = null) {
  if (!["approved", "rejected"].includes(decision)) throw new Error("bad_decision");
  const sb = serviceClient();
  const { data: pick } = await sb
    .from("dropship_picks")
    .select("*, catalog:supplier_catalog_items(*)")
    .eq("id", pickId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (!pick) throw new Error("pick_not_found");

  await sb
    .from("dropship_picks")
    .update({
      status: decision,
      decided_at: new Date().toISOString(),
      decided_by: userId,
    })
    .eq("id", pickId);

  if (decision !== "approved") return { ok: true, status: decision };

  // Create DS- product row (not yet listed).
  const { data: sku, error: skuErr } = await sb.rpc("next_dropship_sku");
  if (skuErr) throw skuErr;
  const cat = pick.catalog;
  const { data: product, error } = await sb
    .from("dropship_products")
    .insert({
      store_id: storeId,
      sku,
      catalog_item_id: cat.id,
      title: cat.title,
      image_url: cat.image_url,
      price_cents: pick.suggested_price_cents,
      cost_cents: cat.cost_cents,
      shipping_cents: cat.shipping_cents,
      channel: pick.channel,
      status: "approved",
      handling_days: Math.max(1, Number(cat.processing_days) || 5) + 2,
      website_noindex: true,
    })
    .select("*")
    .single();
  if (error) throw error;
  return { ok: true, status: "approved", product };
}
