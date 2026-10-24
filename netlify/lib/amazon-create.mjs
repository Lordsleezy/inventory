/**
 * Amazon Listings Items — CREATE new catalog product (LISTING), not offer-only.
 * Always prefer VALIDATION_PREVIEW before live PUT.
 * Never use Generic/unbranded for a branded Floor unit. Never AI images.
 */
import { serviceClient } from "./server.mjs";
import { assertBundlePush } from "./bundle-gate.mjs";
import {
  STORE_DEFAULT,
  spapiFetch,
  marketplaceId,
  amazonConditionFromUnit,
  suggestAmazonPriceCents,
  amazonListingEnabled,
  amazonNeverListReason,
} from "./amazon.mjs";

const LANG = "en_US";

function sellerId() {
  return (process.env.AMAZON_SELLER_ID || "").trim();
}

function v(mp, value) {
  return [{ value, marketplace_id: mp }];
}
function vl(mp, value) {
  return [{ value, language_tag: LANG, marketplace_id: mp }];
}

/** Map Floor unit → STRING_LIGHT attributes (Holiday Living / C9 lights and similar). */
export function buildStringLightAttributes(unit, { listCents, retailCents } = {}) {
  const mp = marketplaceId();
  const specs = unit.listing_specs && typeof unit.listing_specs === "object" ? unit.listing_specs : {};
  const brand = String(unit.brand || "").trim();
  if (!brand) throw new Error("brand_required — never list branded goods as Generic");
  if (/^generic$/i.test(brand)) throw new Error("brand_generic_forbidden");

  const model = String(unit.model || specs.model || "").trim() || "UNKNOWN";
  const upc = String(unit.upc || specs.upc || specs.gtin || "").replace(/\D/g, "");
  const cond = amazonConditionFromUnit(unit);
  const title = String(unit.title || "").slice(0, 200);
  const lengthFt = Number(specs.lighted_length_ft || specs.cable_length_ft || 24) || 24;
  const lightColor = /clear|white/i.test(String(specs.light_color || ""))
    ? "White"
    : String(specs.light_color || "White");
  const bulbType = /led/i.test(String(specs.bulb_type || ""))
    ? "LED"
    : /halogen/i.test(String(specs.bulb_type || ""))
      ? "Halogen"
      : /neon/i.test(String(specs.bulb_type || ""))
        ? "Neon"
        : "Incandescent";
  const outdoor = /outdoor/i.test(String(specs.indoor_outdoor || "Indoor/Outdoor"));
  const price = listCents != null ? listCents : suggestAmazonPriceCents(unit, 0.15, 0.1).listCents;
  const listPrice = Number(((retailCents ?? specs.current_typical_retail_usd * 100 ?? unit.ask_cents ?? price) / 100).toFixed(2));

  const bullets = [
    `${brand} ${specs.bulb_count || ""}-count ${specs.bulb_style || ""} string lights`.replace(/\s+/g, " ").trim(),
    `About ${lengthFt}-ft lighted length; ${outdoor ? "outdoor" : "indoor"} holiday décor`,
    `${bulbType} ${specs.bulb_style || "C9"} bulbs — ${lightColor.toLowerCase()}`,
    `New in original packaging; authentic ${brand} brand (not generic/unbranded)`,
    "Ships from Open Box Industries (United States)",
  ].map((t) => ({ value: t.slice(0, 500), language_tag: LANG, marketplace_id: mp }));

  return {
    productType: "STRING_LIGHT",
    condition: cond,
    attributes: {
      condition_type: v(mp, cond.amazon || "new_new"),
      item_name: vl(mp, title),
      brand: vl(mp, brand),
      manufacturer: vl(mp, brand),
      model_number: v(mp, model),
      model_name: vl(mp, model),
      part_number: v(mp, model),
      ...(upc
        ? {
            externally_assigned_product_identifier: [{ type: "upc", value: upc, marketplace_id: mp }],
            supplier_declared_has_product_identifier_exemption: v(mp, false),
          }
        : {
            supplier_declared_has_product_identifier_exemption: v(mp, true),
          }),
      bullet_point: bullets,
      product_description: vl(mp, String(unit.listing_body || title).slice(0, 2000)),
      country_of_origin: v(mp, specs.country_of_origin || "CN"),
      color: vl(mp, lightColor),
      material: vl(mp, specs.material || "Plastic"),
      special_feature: vl(mp, /plug/i.test(String(specs.power_source || "Plug-in")) ? "Plug-in" : "Corded"),
      theme: vl(mp, /christmas|holiday/i.test(title) ? "Christmas" : "Holiday"),
      occasion_type: vl(mp, /christmas|holiday/i.test(title) ? "Christmas" : "Holiday"),
      power_source_type: vl(mp, "Corded Electric"),
      indoor_outdoor_usage: v(mp, outdoor ? "outdoor" : "indoor"),
      included_components: vl(mp, "String lights"),
      warranty_description: vl(
        mp,
        "Sold as-is by Open Box Industries; no manufacturer warranty transferred.",
      ),
      number_of_items: v(mp, 1),
      unit_count: [{ value: 1, type: { value: "Count", language_tag: LANG }, marketplace_id: mp }],
      list_price: [{ currency: "USD", value: listPrice > 0 ? listPrice : Number((price / 100).toFixed(2)), marketplace_id: mp }],
      supplier_declared_dg_hz_regulation: v(mp, "not_applicable"),
      light_color: vl(mp, lightColor === "Clear" ? "White" : lightColor),
      light_source: [{ type: [{ value: bulbType, language_tag: LANG }], marketplace_id: mp }],
      cable: [{ length: [{ decimal_value: lengthFt, unit: "feet" }], marketplace_id: mp }],
      purchasable_offer: [
        {
          currency: "USD",
          our_price: [{ schedule: [{ value_with_tax: Number((price / 100).toFixed(2)) }] }],
          marketplace_id: mp,
        },
      ],
      fulfillment_availability: [
        { fulfillment_channel_code: "DEFAULT", quantity: 1, marketplace_id: mp },
      ],
      ...(Number(unit.package_length_in || specs.package_length_in) > 0
        && Number(unit.package_width_in || specs.package_width_in) > 0
        && Number(unit.package_height_in || specs.package_height_in) > 0
        ? {
            item_package_dimensions: [
              {
                length: { value: Number(unit.package_length_in || specs.package_length_in), unit: "inches" },
                width: { value: Number(unit.package_width_in || specs.package_width_in), unit: "inches" },
                height: { value: Number(unit.package_height_in || specs.package_height_in), unit: "inches" },
                marketplace_id: mp,
              },
            ],
          }
        : {}),
      ...(Number(unit.package_weight_lb || specs.package_weight_lb) > 0
        ? {
            item_package_weight: [
              {
                value: Number(unit.package_weight_lb || specs.package_weight_lb),
                unit: "pounds",
                marketplace_id: mp,
              },
            ],
          }
        : {}),
      batteries_required: v(mp, false),
      batteries_included: v(mp, false),
    },
  };
}

export function classifyCreateIssues(issues = []) {
  const errors = issues.filter((i) => String(i.severity || "").toUpperCase() === "ERROR");
  const warnings = issues.filter((i) => String(i.severity || "").toUpperCase() === "WARNING");
  const texts = errors.map((e) => `${e.code || ""} ${e.message || ""}`).join(" | ");
  const gs1OrBrand =
    /8572|8566|brand records|GS1|doesn't match our brand|can't create a new one|product ID/i.test(texts);
  const needsImage = /main_product_image|image locator|media_location/i.test(texts);
  const approval = /approval|ungate|gated|enroll|Brand Registry/i.test(texts);
  return {
    errorCount: errors.length,
    warningCount: warnings.length,
    gs1OrBrandBlocked: gs1OrBrand,
    needsImage,
    approvalLikely: approval,
    errors: errors.map((e) => ({
      code: e.code || null,
      message: e.message || null,
      attrs: e.attributeNames || [],
    })),
    warnings: warnings.map((w) => ({
      code: w.code || null,
      message: w.message || null,
      attrs: w.attributeNames || [],
    })),
  };
}

/**
 * VALIDATION_PREVIEW (default) or live LISTING create.
 * Live create requires AMAZON_LISTING_ENABLED=1 and explicit confirmLive=true.
 */
export async function createAmazonCatalogListing(
  storeId,
  sku,
  { overrides = {}, mode = "VALIDATION_PREVIEW", confirmLive = false, productType } = {},
) {
  try { await assertBundlePush(storeId, sku, 'amazon', { intent: false }); }
  catch (error) { return { ok: false, reason: 'bundle_gate', message: error.message }; }
  const sb = serviceClient();
  const { data: unit, error } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (error) throw new Error(error.message);
  if (!unit) return { ok: false, reason: "unknown_sku" };
  const never = amazonNeverListReason(unit);
  if (never) return { ok: false, reason: "never_list", message: never };

  const sid = sellerId();
  if (!sid) return { ok: false, reason: "missing_seller_id", message: "AMAZON_SELLER_ID not set" };

  let built;
  try {
    built = buildStringLightAttributes(unit, {
      listCents: overrides.price_cents,
      retailCents: overrides.retail_cents,
    });
  } catch (e) {
    return { ok: false, reason: "attribute_build_failed", message: e instanceof Error ? e.message : String(e) };
  }

  const attrs = { ...built.attributes, ...(overrides.attributes || {}) };
  // Optional image locator — only if caller supplies a media_location Amazon already hosts
  if (overrides.main_image_media_location) {
    attrs.main_product_image_locator = [
      { media_location: overrides.main_image_media_location, marketplace_id: marketplaceId() },
    ];
  }

  const pt = productType || overrides.product_type || built.productType || "STRING_LIGHT";
  const live = mode !== "VALIDATION_PREVIEW";
  if (live) {
    if (!amazonListingEnabled()) {
      return { ok: false, reason: "amazon_listing_disabled", message: "Set AMAZON_LISTING_ENABLED=1 for live create." };
    }
    if (!confirmLive) {
      return { ok: false, reason: "confirm_required", message: "Pass confirmLive=true after a clean VALIDATION_PREVIEW." };
    }
    try { await assertBundlePush(storeId, sku, 'amazon'); }
    catch (error) { return { ok: false, reason: 'bundle_gate', message: error.message }; }
  }

  const sellerSku = live ? `AMZ-NEW-${sku}` : `FLOOR-PREVIEW-${sku}`;
  const path =
    `/listings/2021-08-01/items/${encodeURIComponent(sid)}/${encodeURIComponent(sellerSku)}` +
    `?marketplaceIds=${marketplaceId()}` +
    (live ? "" : "&mode=VALIDATION_PREVIEW");

  let json;
  try {
    json = await spapiFetch(storeId, "PUT", path, {
      productType: pt,
      requirements: "LISTING",
      attributes: attrs,
    });
  } catch (e) {
    const classified = classifyCreateIssues(e?.body?.issues || []);
    // Amazon sometimes returns HTTP errors with issue payloads
    if (e?.body?.issues) {
      return {
        ok: false,
        reason: classified.gs1OrBrandBlocked ? "gs1_brand_mismatch" : "spapi_error",
        message: e.message,
        httpStatus: e.status,
        productType: pt,
        sellerSku,
        mode: live ? "LIVE" : "VALIDATION_PREVIEW",
        ...classified,
        raw: e.body,
      };
    }
    return {
      ok: false,
      reason: "spapi_error",
      message: e instanceof Error ? e.message : String(e),
      httpStatus: e?.status || null,
      raw: e?.body || null,
    };
  }

  const classified = classifyCreateIssues(json?.issues || []);
  const clean = classified.errorCount === 0;
  const result = {
    ok: clean,
    reason: clean ? null : classified.gs1OrBrandBlocked ? "gs1_brand_mismatch" : "validation_errors",
    message: clean
      ? live
        ? "Create submitted"
        : "VALIDATION_PREVIEW clean"
      : classified.errors[0]?.message || "Validation errors",
    productType: pt,
    sellerSku,
    mode: live ? "LIVE" : "VALIDATION_PREVIEW",
    status: json?.status || null,
    submissionId: json?.submissionId || null,
    brand: unit.brand,
    upc: unit.upc,
    ...classified,
    raw: json,
  };

  if (!live && classified.gs1OrBrandBlocked) {
    const { error: markErr } = await sb
      .from("amazon_list_items")
      .update({
        status: "not_on_amazon",
        needs_review_reason:
          "Not on Amazon — UPC/brand not in Amazon GS1 brand records. Sell on other channels (or get brand/GTIN authorization).",
        last_error: classified.errors.map((e) => e.message).join(" · ").slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("store_id", storeId)
      .eq("sku", sku);
    result.autoMarkedNotOnAmazon = !markErr;
    if (markErr) result.markError = markErr.message;
  }

  return result;
}

export async function markAmazonNotOnAmazon(storeId, sku, reason) {
  const sb = serviceClient();
  const msg =
    reason ||
    "Not on Amazon — sell on other channels (no catalog ASIN; create blocked or skipped).";
  const { error } = await sb
    .from("amazon_list_items")
    .update({
      status: "not_on_amazon",
      needs_review_reason: msg,
      updated_at: new Date().toISOString(),
    })
    .eq("store_id", storeId)
    .eq("sku", sku);
  if (error) throw new Error(error.message);
  return { ok: true, sku, status: "not_on_amazon", reason: msg };
}

export async function searchAmazonProductTypes(storeId, keywords) {
  const path =
    `/definitions/2020-09-01/productTypes?marketplaceIds=${marketplaceId()}` +
    `&keywords=${encodeURIComponent(keywords)}`;
  return spapiFetch(storeId, "GET", path);
}

export { STORE_DEFAULT };
