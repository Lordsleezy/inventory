/**
 * Public read of website Everyday deals (DS- products).
 * Separated from open-box inventory. Pages are noindex until settings flip.
 */
import { serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { netlifyHandler } from "../lib/floor-log.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(event), body: "" };
  if (event.httpMethod !== "GET") return json(405, { error: "get_only" });

  const sb = serviceClient();
  const storeId = event.queryStringParameters?.store_id;
  let q = sb
    .from("dropship_products")
    .select("sku, title, image_url, price_cents, handling_days, website_noindex, status, catalog:supplier_catalog_items(ships_from_us, processing_days, warehouse_city, warehouse_region)")
    .eq("channel", "website")
    .eq("status", "listed")
    .order("listed_at", { ascending: false })
    .limit(100);
  if (storeId) q = q.eq("store_id", storeId);

  // Only return deals when website channel is on for that store.
  const { data: settingsRows } = await sb
    .from("dropship_settings")
    .select("store_id, enabled, website_channel_on, settings")
    .eq("website_channel_on", true)
    .eq("enabled", true);
  const allowed = new Set((settingsRows || []).map((r) => r.store_id));
  if (!allowed.size) {
    return json(200, {
      section: "Everyday deals",
      items: [],
      noindex: true,
      note: "Website dropship channel is off.",
    });
  }

  const { data, error } = await q;
  if (error) return json(500, { error: error.message });
  const items = (data || [])
    .filter((row) => !storeId || allowed.has(storeId) || allowed.has(row.store_id))
    .map((row) => {
      const days = Number(row.handling_days || row.catalog?.processing_days || 5);
      return {
        sku: row.sku,
        title: row.title,
        image_url: row.image_url,
        price_cents: row.price_cents,
        delivery_window: `${days}–${days + 3} business days`,
        ships_from_us: Boolean(row.catalog?.ships_from_us),
        noindex: row.website_noindex !== false,
      };
    });

  const anyIndex = items.some((i) => !i.noindex);
  return json(200, {
    section: "Everyday deals",
    items,
    noindex: !anyIndex,
    robots: anyIndex ? "index,follow" : "noindex,nofollow",
    note: "Separate from open-box inventory. Honest delivery window shown at checkout.",
  });
}

export const handler = netlifyHandler("dropship-everyday-deals", handle);
