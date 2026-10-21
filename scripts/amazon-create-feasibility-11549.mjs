/**
 * Live SP-API feasibility for creating a NEW Amazon catalog listing for SKU 11549.
 * VALIDATION_PREVIEW only — never publishes.
 *
 * Usage (with Netlify env loaded by caller):
 *   node scripts/amazon-create-feasibility-11549.mjs
 */
import { writeFileSync } from "node:fs";
import {
  STORE_DEFAULT,
  spapiFetch,
  marketplaceId,
  searchCatalogAsin,
  amazonConditionFromUnit,
  suggestAmazonPriceCents,
} from "../netlify/lib/amazon.mjs";
import { serviceClient } from "../netlify/lib/server.mjs";

const STORE = STORE_DEFAULT;
const SKU = "11549";
const out = { sku: SKU, at: new Date().toISOString(), steps: {} };

function sellerId() {
  return (process.env.AMAZON_SELLER_ID || "").trim();
}

async function safe(label, fn) {
  try {
    const data = await fn();
    out.steps[label] = { ok: true, data };
    return data;
  } catch (e) {
    out.steps[label] = {
      ok: false,
      status: e?.status || null,
      code: e?.code || null,
      message: e instanceof Error ? e.message : String(e),
      body: e?.body || null,
    };
    return null;
  }
}

async function main() {
  const sb = serviceClient();
  const { data: unit, error } = await sb.from("units").select("*").eq("store_id", STORE).eq("sku", SKU).maybeSingle();
  if (error) throw new Error(error.message);
  if (!unit) throw new Error("unit_not_found");
  const { count: photos } = await sb
    .from("photos")
    .select("id", { count: "exact", head: true })
    .eq("store_id", STORE)
    .eq("sku", SKU);

  out.unit = {
    sku: unit.sku,
    title: unit.title,
    brand: unit.brand,
    model: unit.model,
    upc: unit.upc,
    condition: unit.condition,
    ask_cents: unit.ask_cents,
    floor_cents: unit.floor_cents,
    photos,
    listing_specs: unit.listing_specs,
  };

  const sid = sellerId();
  out.sellerId = sid || null;
  out.marketplaceId = marketplaceId();

  // 1) Catalog search — confirm no ASIN
  out.catalog = await safe("catalog_search", () => searchCatalogAsin(STORE, unit));

  // 2) Product type search for Christmas string lights
  const keywords = ["christmas string lights", "C9 string lights", "holiday string lights", "lighted decoration"];
  out.productTypeSearch = {};
  for (const kw of keywords) {
    const path =
      `/definitions/2020-09-01/productTypes?marketplaceIds=${marketplaceId()}` +
      `&keywords=${encodeURIComponent(kw)}`;
    const json = await safe(`productTypes_${kw.replace(/\s+/g, "_")}`, () => spapiFetch(STORE, "GET", path));
    out.productTypeSearch[kw] = json;
  }

  // Pick best product type candidate
  const candidates = [];
  for (const json of Object.values(out.productTypeSearch)) {
    for (const row of json?.productTypes || json?.data?.productTypes || []) {
      candidates.push(row);
    }
  }
  // Prefer names suggesting lights / decorative lighting
  const scored = candidates.map((c) => {
    const name = `${c.name || ""} ${c.displayName || ""} ${c.productType || ""}`.toLowerCase();
    let score = 0;
    if (/light|lamp|decor|holiday|season/.test(name)) score += 3;
    if (/string|christmas|c9/.test(name)) score += 5;
    return { ...c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const productType =
    scored[0]?.productType ||
    scored[0]?.name ||
    "STRING_LIGHT";
  out.chosenProductType = { productType, top: scored.slice(0, 8) };

  // 3) Product type definition (LISTING = create new product)
  const defPath =
    `/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}` +
    `?marketplaceIds=${marketplaceId()}&requirements=LISTING` +
    (sid ? `&sellerId=${encodeURIComponent(sid)}` : "") +
    `&locale=en_US`;
  const definition = await safe("productTypeDefinition_LISTING", () => spapiFetch(STORE, "GET", defPath));

  // Extract required attributes from schema if present
  const schema = definition?.schema || definition?.propertyGroups || null;
  out.definitionMeta = {
    productType: definition?.productType || productType,
    requirements: definition?.requirements || null,
    requirementsEnforced: definition?.requirementsEnforced || null,
    productTypeVersion: definition?.productTypeVersion || null,
    propertyGroups: Array.isArray(definition?.propertyGroups)
      ? definition.propertyGroups.map((g) => ({
          title: g.title || g.name,
          propertyNames: g.propertyNames || g.properties || null,
        }))
      : null,
    metaSchemaUrl: definition?.metaSchema?.link?.resource || definition?.schema?.$id || null,
  };

  // Fetch JSON schema document if Amazon returns a link
  const schemaLink =
    definition?.schema?.link?.resource ||
    definition?.schema?.$ref ||
    (typeof definition?.schema === "string" ? definition.schema : null);
  if (schemaLink && String(schemaLink).startsWith("http")) {
    await safe("productTypeSchema_fetch", async () => {
      const res = await fetch(schemaLink);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 2000) };
      }
      const required = json?.required || json?.properties?.attributes?.required || [];
      const props = json?.properties?.attributes?.properties || json?.properties || {};
      const safetyKeys = Object.keys(props).filter((k) =>
        /safety|warning|voltage|watt|electrical|compliance|batter|age|choking|prop65|ul_|etl|cert/i.test(k),
      );
      out.schemaSummary = {
        status: res.status,
        requiredTop: required,
        attributeCount: Object.keys(props).length,
        safetyOrComplianceKeys: safetyKeys,
        sampleKeys: Object.keys(props).slice(0, 40),
      };
      // keep truncated schema for report artifact
      out.schemaTrunc = JSON.stringify(json).slice(0, 12000);
      return out.schemaSummary;
    });
  }

  // 4) Restrictions without ASIN — Amazon may reject; also try with a known similar ASIN if catalog found none
  const cond = amazonConditionFromUnit(unit);
  out.condition = cond;
  if (out.catalog?.asin) {
    await safe("restrictions_existing_asin", () =>
      spapiFetch(
        STORE,
        "GET",
        `/listings/2021-08-01/restrictions?asin=${encodeURIComponent(out.catalog.asin)}&sellerId=${encodeURIComponent(sid)}&marketplaceIds=${marketplaceId()}&conditionType=${encodeURIComponent(cond.amazon || "new_new")}`,
      ),
    );
  } else {
    out.steps.restrictions_existing_asin = {
      ok: false,
      message: "skipped_no_catalog_asin",
    };
  }

  // Brand / UPC notes from catalog identifiers search by UPC alone
  await safe("catalog_upc_only", () =>
    spapiFetch(
      STORE,
      "GET",
      `/catalog/2022-04-01/items?marketplaceIds=${marketplaceId()}&identifiers=${encodeURIComponent(unit.upc || "")}&identifiersType=UPC&includedData=summaries,identifiers,productTypes&pageSize=5`,
    ),
  );

  // 5) VALIDATION_PREVIEW — product create (LISTING), real brand + UPC, no live publish
  const price = suggestAmazonPriceCents(unit, 0.15, 0.1);
  const brand = String(unit.brand || "Holiday Living").trim();
  const title = String(unit.title || "").slice(0, 200);
  const bullets = [
    "Holiday Living 25-count clear C9 Christmas string lights",
    "Approximately 24 ft string — outdoor/indoor holiday décor",
    "New in box; Floor SKU " + SKU,
    "Genuine Holiday Living (Lowe's store brand) — not generic/unbranded",
    "Ships from Open Box Industries (US)",
  ].map((t) => ({ value: t.slice(0, 500), marketplace_id: marketplaceId() }));

  const attributes = {
    condition_type: [{ value: cond.amazon || "new_new", marketplace_id: marketplaceId() }],
    item_name: [{ value: title, marketplace_id: marketplaceId() }],
    brand: [{ value: brand, marketplace_id: marketplaceId() }],
    externally_assigned_product_identifier: [
      { type: "upc", value: String(unit.upc || "").replace(/\D/g, ""), marketplace_id: marketplaceId() },
    ],
    supplier_declared_has_product_identifier_exemption: [{ value: false, marketplace_id: marketplaceId() }],
    bullet_point: bullets,
    product_description: [
      {
        value: String(unit.listing_body || unit.title || title).slice(0, 2000),
        marketplace_id: marketplaceId(),
      },
    ],
    country_of_origin: [{ value: "US", marketplace_id: marketplaceId() }],
    purchasable_offer: [
      {
        currency: "USD",
        our_price: [{ schedule: [{ value_with_tax: Number((price.listCents / 100).toFixed(2)) }] }],
        marketplace_id: marketplaceId(),
      },
    ],
    fulfillment_availability: [
      {
        fulfillment_channel_code: "DEFAULT",
        quantity: 1,
        marketplace_id: marketplaceId(),
      },
    ],
    // Common lighting attrs — Amazon may reject unknown keys; preview will say
    number_of_lights: [{ value: 25, marketplace_id: marketplaceId() }],
    light_color: [{ value: "Clear", marketplace_id: marketplaceId() }],
  };

  const previewSku = `FLOOR-PREVIEW-${SKU}`;
  const payload = {
    productType,
    requirements: "LISTING",
    attributes,
  };

  const putPath =
    `/listings/2021-08-01/items/${encodeURIComponent(sid)}/${encodeURIComponent(previewSku)}` +
    `?marketplaceIds=${marketplaceId()}&mode=VALIDATION_PREVIEW`;

  out.validationPreview = {
    path: putPath,
    productType,
    brand,
    upc: unit.upc,
    listCents: price.listCents,
  };

  await safe("validation_preview_LISTING", () => spapiFetch(STORE, "PUT", putPath, payload));

  // Also try LISTING_OFFER_ONLY without ASIN — should fail clearly
  await safe("validation_preview_OFFER_ONLY_no_asin", () =>
    spapiFetch(STORE, "PUT", putPath, {
      productType: "PRODUCT",
      requirements: "LISTING_OFFER_ONLY",
      attributes: {
        condition_type: attributes.condition_type,
        purchasable_offer: attributes.purchasable_offer,
        fulfillment_availability: attributes.fulfillment_availability,
      },
    }),
  );

  // Plain-English verdict
  const preview = out.steps.validation_preview_LISTING;
  const upcHit = out.steps.catalog_upc_only;
  const issues = [];
  if (!preview?.ok) {
    issues.push(`VALIDATION_PREVIEW failed: ${preview?.message || "unknown"}`);
    const errs = preview?.body?.issues || preview?.body?.errors || [];
    if (Array.isArray(errs) && errs.length) {
      for (const e of errs.slice(0, 20)) {
        issues.push(
          `issue: ${e.code || e.severityCode || ""} ${e.message || e.attributeNames || JSON.stringify(e).slice(0, 200)}`,
        );
      }
    }
  } else {
    const issuesArr = preview.data?.issues || [];
    const errors = issuesArr.filter((i) => String(i.severity || "").toUpperCase() === "ERROR");
    const warnings = issuesArr.filter((i) => String(i.severity || "").toUpperCase() === "WARNING");
    out.previewIssueCounts = { errors: errors.length, warnings: warnings.length, total: issuesArr.length };
    for (const e of errors.slice(0, 25)) {
      issues.push(`ERROR ${e.code || ""} ${e.message || ""} attrs=${(e.attributeNames || []).join(",")}`);
    }
    for (const w of warnings.slice(0, 15)) {
      issues.push(`WARN ${w.code || ""} ${w.message || ""}`);
    }
  }

  const upcItems = upcHit?.data?.items || [];
  out.verdict = {
    catalogAsinFound: Boolean(out.catalog?.asin),
    upcSearchItemCount: upcItems.length,
    productType,
    canCreateLikely: Boolean(preview?.ok && (out.previewIssueCounts?.errors || 0) === 0),
    brandGatingSignals: issues.filter((s) => /brand|approval|gated|unauthorized|enroll/i.test(s)),
    gs1Signals: issues.filter((s) => /upc|ean|gtin|identifier|gs1|brand.?registry/i.test(s)),
    issues,
  };

  const path = "/tmp/amazon-feasibility-11549.json";
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ wrote: path, verdict: out.verdict, chosenProductType: out.chosenProductType, definitionMeta: out.definitionMeta, previewIssueCounts: out.previewIssueCounts }, null, 2));
}

main().catch((e) => {
  console.error(e);
  writeFileSync("/tmp/amazon-feasibility-11549.json", JSON.stringify({ ok: false, error: String(e), out }, null, 2));
  process.exit(1);
});
