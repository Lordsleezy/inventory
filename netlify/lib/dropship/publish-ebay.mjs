import { serviceClient } from "../server.mjs";
import { ebayFetch } from "../ebay.mjs";

async function quietGet(storeId, path) {
  try {
    return await ebayFetch(storeId, "GET", path);
  } catch (err) {
    return {
      _error: err instanceof Error ? err.message : String(err),
      _status: err.status || null,
    };
  }
}
import { enqueueDropshipAlert } from "./alerts.mjs";
import { isDropshipSku } from "./types.mjs";

/**
 * eBay publish for DS- items with hard guardrails.
 * Fail closed when packing-slip / blind shipping is unverified.
 */
export async function publishDropshipToEbay(storeId, productId, opts = {}) {
  const sb = serviceClient();
  const { data: settings } = await sb.from("dropship_settings").select("*").eq("store_id", storeId).maybeSingle();
  if (!settings?.enabled) throw fail("dropship_off");
  if (settings.paused) throw fail(`dropship_paused:${settings.pause_reason || ""}`);
  if (!settings.ebay_channel_on) throw fail("ebay_channel_off");

  const rules = settings.settings || {};
  if (rules.cj_blind_shipping_verified !== true) {
    throw fail(
      "blind_shipping_unverified: CJ packing slip / Open Box Industries branding not confirmed. No eBay publish until Paul sets cj_blind_shipping_verified.",
    );
  }

  const { data: product } = await sb
    .from("dropship_products")
    .select("*, catalog:supplier_catalog_items(*)")
    .eq("id", productId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (!product) throw fail("product_not_found");
  if (!isDropshipSku(product.sku)) throw fail("not_ds_sku");
  if (product.channel !== "ebay") throw fail("wrong_channel");
  if (settings.sample_gate_required !== false && rules.sample_gate_required !== false && !product.sample_verified) {
    throw fail("sample_gate: order a sample to yourself and mark verified before publish");
  }

  const cat = product.catalog;
  if (!cat?.ships_from_us) throw fail("not_us_warehouse");
  if (!cat.warehouse_city || !cat.warehouse_region || !cat.warehouse_postal) {
    throw fail("warehouse_location_incomplete: city/state/zip required for eBay item location");
  }

  // Selling limits
  const privileges = await getEbayPrivileges(storeId);
  if (privileges?.listingLimitRemaining != null && privileges.listingLimitRemaining < 1) {
    throw fail(`ebay_listing_limit:${privileges.listingLimitRemaining}`);
  }

  // Daily publish cap
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const { count } = await sb
    .from("dropship_products")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("channel", "ebay")
    .eq("status", "listed")
    .gte("listed_at", start.toISOString());
  if ((count || 0) >= (settings.daily_publish_cap ?? 5)) {
    throw fail(`daily_publish_cap:${settings.daily_publish_cap}`);
  }

  const handlingDays = Math.max(
    1,
    Number(product.handling_days) || Number(cat.processing_days) || 5,
  ) + Number(opts.handlingBufferDays ?? 2);

  const locKey = await ensureWarehouseLocation(storeId, cat);

  // Create inventory item + offer with DS- SKU as custom label.
  const title = String(product.title).slice(0, 80);
  const images = product.image_url ? [product.image_url] : cat.image_url ? [cat.image_url] : [];
  if (!images.length) throw fail("no_image");

  // Honest listings only: aspects from supplier/catalog data + cached category form — never invent.
  const aspects = await buildHonestAspects(storeId, cat, opts.categoryId);
  if (aspects.missingRequired?.length) {
    throw fail(`missing_required_aspects:${aspects.missingRequired.join(",")}`);
  }

  await ebayFetch(storeId, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(product.sku)}`, {
    availability: {
      shipToLocationAvailability: {
        quantity: 1,
        availabilityDistributions: [{ merchantLocationKey: locKey, quantity: 1 }],
      },
    },
    condition: "NEW",
    product: {
      title,
      description: websiteStyleDescription(product, cat, handlingDays),
      imageUrls: images,
      aspects: aspects.values,
    },
  });

  // Policies: reuse store defaults via existing helper paths when possible.
  const policies = await resolvePolicies(storeId);
  const offerBody = {
    sku: product.sku,
    marketplaceId: "EBAY_US",
    format: "FIXED_PRICE",
    availableQuantity: 1,
    categoryId: String(opts.categoryId || "1"), // caller should pass a real category; 1 is placeholder fail-soft
    listingDescription: websiteStyleDescription(product, cat, handlingDays),
    listingPolicies: {
      fulfillmentPolicyId: policies.fulfillment,
      paymentPolicyId: policies.payment,
      returnPolicyId: policies.returnP,
    },
    merchantLocationKey: locKey,
    listingDuration: "GTC",
    pricingSummary: {
      price: { value: (product.price_cents / 100).toFixed(2), currency: "USD" },
    },
  };

  if (!policies.fulfillment || !policies.payment || !policies.returnP) {
    throw fail("ebay_policies_missing");
  }

  // Prefer a fulfillment policy whose handling time >= our handlingDays — we cannot
  // invent policy IDs here; surface for Paul if mismatch.
  const created = await ebayFetch(storeId, "POST", "/sell/inventory/v1/offer", offerBody);
  const offerId = created.offerId;
  let published;
  try {
    published = await ebayFetch(storeId, "POST", `/sell/inventory/v1/offer/${offerId}/publish`);
  } catch (err) {
    await sb
      .from("dropship_products")
      .update({ status: "error", last_error: String(err.message || err).slice(0, 500), ebay_offer_id: offerId })
      .eq("id", product.id);
    throw err;
  }

  const listingId = published.listingId || published.listing?.listingId || null;
  await sb
    .from("dropship_products")
    .update({
      status: "listed",
      ebay_offer_id: offerId,
      ebay_listing_id: listingId,
      ebay_item_location: {
        city: cat.warehouse_city,
        state: cat.warehouse_region,
        postal: cat.warehouse_postal,
        country: "US",
        merchantLocationKey: locKey,
      },
      handling_days: handlingDays,
      listed_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", product.id);

  // Mirror into listings table so order sync / listing manager can see it, marked DS-.
  await sb.from("listings").upsert(
    {
      store_id: storeId,
      sku: product.sku,
      channel: "ebay",
      status: "listed",
      listing_id: listingId,
      offer_id: offerId,
      listed_at: new Date().toISOString(),
      delisted_at: null,
    },
    { onConflict: "store_id,sku,channel" },
  );

  return { sku: product.sku, offerId, listingId, handlingDays, locKey };
}

export async function endAllDropshipEbayListings(storeId) {
  const sb = serviceClient();
  const { data: rows } = await sb
    .from("dropship_products")
    .select("id, sku, ebay_offer_id")
    .eq("store_id", storeId)
    .eq("channel", "ebay")
    .eq("status", "listed");
  const results = [];
  for (const row of rows || []) {
    try {
      if (row.ebay_offer_id) {
        await ebayFetch(storeId, "POST", `/sell/inventory/v1/offer/${row.ebay_offer_id}/withdraw`, {
          listingId: undefined,
        });
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
        .eq("channel", "ebay");
      results.push({ sku: row.sku, ok: true });
    } catch (err) {
      results.push({ sku: row.sku, ok: false, error: err.message });
    }
  }
  await enqueueDropshipAlert(storeId, "DS-", `Ended ${results.filter((r) => r.ok).length} dropship eBay listings.`, {
    kind_detail: "end_all",
    results,
  });
  return results;
}

async function getEbayPrivileges(storeId) {
  try {
    const data = await ebayFetch(storeId, "GET", "/sell/account/v1/privilege");
    return {
      listingLimitRemaining: data?.sellingLimit?.quantity?.value ?? data?.sellingLimitRemaining ?? null,
      raw: data,
    };
  } catch {
    return { listingLimitRemaining: null };
  }
}

async function ensureWarehouseLocation(storeId, cat) {
  const key = `ds_cj_${String(cat.warehouse_id || cat.warehouse_postal || "us")}`
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, 36);
  const existing = await quietGet(storeId, `/sell/inventory/v1/location/${encodeURIComponent(key)}`);
  if (existing && !existing._error) return key;
  await ebayFetch(storeId, "POST", `/sell/inventory/v1/location/${encodeURIComponent(key)}`, {
    location: {
      address: {
        city: cat.warehouse_city,
        stateOrProvince: cat.warehouse_region,
        postalCode: cat.warehouse_postal,
        country: "US",
      },
    },
    name: `CJ ${cat.warehouse_city}`,
    merchantLocationStatus: "ENABLED",
    locationTypes: ["WAREHOUSE"],
  });
  return key;
}

async function resolvePolicies(storeId) {
  // Pull from store_settings or ebay account defaults if present.
  const sb = serviceClient();
  const { data } = await sb
    .from("store_settings")
    .select("key, value")
    .eq("store_id", storeId)
    .in("key", ["ebay_fulfillment_policy_id", "ebay_payment_policy_id", "ebay_return_policy_id"]);
  const map = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  return {
    fulfillment: map.ebay_fulfillment_policy_id || null,
    payment: map.ebay_payment_policy_id || null,
    returnP: map.ebay_return_policy_id || null,
  };
}

function websiteStyleDescription(product, cat, handlingDays) {
  return [
    `<p>${escapeHtml(product.title)}</p>`,
    `<p>Ships from a US warehouse. Estimated handling about ${handlingDays} business days before tracking.</p>`,
    `<p>Sold by Open Box Industries. Dropship SKU ${escapeHtml(product.sku)}.</p>`,
  ].join("\n");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fail(message) {
  const err = new Error(message);
  err.code = "dropship_publish_blocked";
  return err;
}

/** Build aspects only from known supplier fields + cached category aspects. No invented claims. */
async function buildHonestAspects(storeId, cat, categoryId) {
  const values = {};
  if (cat.brand) values.Brand = [String(cat.brand)];
  else values.Brand = ["Unbranded"];
  if (cat.category) values.Type = [String(cat.category)];
  if (cat.upc) values.UPC = [String(cat.upc)];

  const missingRequired = [];
  if (categoryId) {
    try {
      const sb = serviceClient();
      const { data: form } = await sb
        .from("ebay_category_aspects")
        .select("aspects")
        .eq("category_id", String(categoryId))
        .maybeSingle();
      const aspects = form?.aspects || [];
      for (const a of aspects) {
        const name = a.name || a.localizedAspectName;
        if (!name) continue;
        const required = a.aspectConstraint?.aspectRequired || a.required;
        if (required && !values[name]) {
          // Only fill when we have a clear supplier mapping; otherwise leave missing.
          missingRequired.push(name);
        }
      }
    } catch {
      /* cache optional */
    }
  }
  return { values, missingRequired };
}

export { getEbayPrivileges };
