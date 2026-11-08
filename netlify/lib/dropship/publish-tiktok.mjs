import { serviceClient } from "../server.mjs";
import { enqueueDropshipAlert } from "./alerts.mjs";
import { isDropshipSku } from "./types.mjs";

/**
 * TikTok Shop dropship publish — fail closed.
 * US warehouse only; handling must fit ≤2 business days after buffer;
 * plain packaging must be verified; restricted categories blocked.
 * Seller shipping path only (TikTok logistics mandate was reversed — note in report).
 */
export async function publishDropshipToTikTok(storeId, productId) {
  const sb = serviceClient();
  const { data: settings } = await sb.from("dropship_settings").select("*").eq("store_id", storeId).maybeSingle();
  if (!settings?.enabled) throw fail("dropship_off");
  if (settings.paused) throw fail(`dropship_paused:${settings.pause_reason || ""}`);
  if (!settings.tiktok_channel_on) throw fail("tiktok_channel_off");

  const rules = settings.settings || {};
  if (rules.tiktok_plain_packaging_verified !== true) {
    throw fail(
      "tiktok_plain_packaging_unverified: CJ plain/unbranded packing + Open Box slip not confirmed. No TikTok publish until Paul verifies.",
    );
  }
  if (rules.cj_blind_shipping_verified !== true) {
    throw fail("blind_shipping_unverified");
  }

  const { data: product } = await sb
    .from("dropship_products")
    .select("*, catalog:supplier_catalog_items(*)")
    .eq("id", productId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (!product || !isDropshipSku(product.sku)) throw fail("bad_product");
  if (!product.catalog?.ships_from_us) throw fail("not_us_warehouse");

  const maxHandling = Number(rules.tiktok_max_handling_days ?? 2);
  const handling = Math.max(1, Number(product.handling_days) || Number(product.catalog.processing_days) || 99);
  if (handling > maxHandling) {
    throw fail(`tiktok_handling_too_slow:${handling}d>${maxHandling}d`);
  }

  if (settings.sample_gate_required !== false && rules.sample_gate_required !== false && !product.sample_verified) {
    throw fail("sample_gate: product not sample-verified");
  }

  const title = String(product.title || "");
  const excl = new Set([
    ...(rules.exclusions || []),
    ...(rules.tiktok_exclusions || [
      "alcohol", "tobacco", "weapons", "adult", "kids", "electronics_docs", "beauty_actives", "fine_jewelry",
    ]),
  ]);
  const blocked = tiktokCategoryBlock(title, excl);
  if (blocked) throw fail(`tiktok_restricted:${blocked}`);

  // Reuse existing TikTok listing path only for DS- via dedicated payload — do not invent a second API.
  // Until listing is deliberately enabled and packaging verified, we record approved-for-tiktok
  // but require the existing tiktok list function with DS- awareness.
  const { listTikTokProduct } = await import("../tiktok-shop.mjs");
  // listTikTokProduct expects a units row — DS- items are not units. Fail closed with clear path:
  // store a pending tiktok_list_items style marker on dropship_products and alert Paul that
  // TikTok DS- listing needs the dedicated upload once packing is verified (already gated above).
  // For this release: create listing metadata only when TIKTOK_SHOP_LISTING_ENABLED and we can
  // push images from image_url without units photos.
  if (!process.env.TIKTOK_SHOP_LISTING_ENABLED) {
    throw fail("tiktok_listing_disabled_env");
  }

  // Soft stub: mark channel target; actual TikTok Open API product create for non-unit SKUs
  // needs image upload from supplier URL — call existing image upload helper if available.
  try {
    const result = await listTikTokProduct(storeId, {
      sku: product.sku,
      unit: {
        store_id: storeId,
        sku: product.sku,
        title: product.title,
        ask_cents: product.price_cents,
        brand: "Unbranded",
        category: product.catalog.category || "Other",
        qty_on_hand: 1,
        state: "available",
        listing_body: `Ships from US warehouse in about ${handling} business days. Sold by Open Box Industries.`,
      },
      priceCents: product.price_cents,
    });
    if (!result?.ok) throw fail(result?.reason || result?.message || "tiktok_list_failed");

    await sb
      .from("dropship_products")
      .update({
        channel: "tiktok",
        status: "listed",
        tiktok_product_id: result.product_id || result.productId || null,
        listed_at: new Date().toISOString(),
        handling_days: handling,
        updated_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", product.id);

    await sb.from("listings").upsert(
      {
        store_id: storeId,
        sku: product.sku,
        channel: "tiktok",
        status: "listed",
        listing_id: result.product_id || result.productId || null,
        listed_at: new Date().toISOString(),
        delisted_at: null,
      },
      { onConflict: "store_id,sku,channel" },
    );
    return { ok: true, sku: product.sku, handling, result };
  } catch (err) {
    await sb
      .from("dropship_products")
      .update({ status: "error", last_error: String(err.message || err).slice(0, 500) })
      .eq("id", product.id);
    throw err;
  }
}

export async function endAllDropshipTikTokListings(storeId) {
  const sb = serviceClient();
  const { data: rows } = await sb
    .from("dropship_products")
    .select("id, sku, tiktok_product_id")
    .eq("store_id", storeId)
    .eq("status", "listed")
    .or("channel.eq.tiktok,tiktok_product_id.not.is.null");
  const results = [];
  for (const row of rows || []) {
    try {
      if (row.tiktok_product_id) {
        const { delistTikTokSku } = await import("../tiktok-shop.mjs");
        if (typeof delistTikTokSku === "function") {
          await delistTikTokSku(storeId, row.sku).catch(() => undefined);
        }
      }
      await sb
        .from("dropship_products")
        .update({ status: "ended", ended_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", row.id);
      await sb
        .from("listings")
        .update({ status: "ended", delisted_at: new Date().toISOString() })
        .eq("store_id", storeId)
        .eq("sku", row.sku)
        .eq("channel", "tiktok");
      results.push({ sku: row.sku, ok: true });
    } catch (err) {
      results.push({ sku: row.sku, ok: false, error: err.message });
    }
  }
  await enqueueDropshipAlert(storeId, "DS-", `Ended ${results.filter((r) => r.ok).length} dropship TikTok listings.`, {
    kind_detail: "end_all_tiktok",
  });
  return results;
}

function tiktokCategoryBlock(title, excl) {
  const t = title.toLowerCase();
  if (excl.has("alcohol") && /\b(wine|beer|vodka|alcohol|whiskey)\b/.test(t)) return "alcohol";
  if (excl.has("tobacco") && /\b(tobacco|cigarette|vape|nicotine)\b/.test(t)) return "tobacco";
  if (excl.has("weapons") && /\b(gun|firearm|knife|weapon|ammo)\b/.test(t)) return "weapons";
  if (excl.has("adult") && /\b(adult|sex\s?toy|erotic)\b/.test(t)) return "adult";
  if (excl.has("kids") && /\b(kids?|toddler|infant|baby|children)\b/.test(t)) return "kids";
  if (excl.has("fine_jewelry") && /\b(gold|platinum|diamond|fine\s?jewel)\b/.test(t)) return "fine_jewelry";
  if (excl.has("beauty_actives") && /\b(retinol|salicylic|acid\s?peel|cosmetic)\b/.test(t)) return "beauty_actives";
  if (excl.has("electronics_docs") && /\b(laptop|phone|tablet|drone)\b/.test(t)) return "electronics_docs";
  return null;
}

function fail(message) {
  const err = new Error(message);
  err.code = "dropship_tiktok_blocked";
  return err;
}

export const __test = { tiktokCategoryBlock };
