#!/usr/bin/env node
/**
 * Push Floor-ready inventory to ikonikdeals2026 with OBI listing rules:
 * - Floor ask; +10% when under $15
 * - Calculated shipping + local pickup (Penryn)
 * - Open-box condition when the category offers it
 * - Clearance footer; no Promoted Listings
 * - Catalog photo first when Floor has a confirmed match, then unit photos
 *
 * Usage:
 *   STORE_ID=... node scripts/ebay-bulk-push-ready.mjs --skus-file /tmp/push_skus.json
 *   STORE_ID=... node scripts/ebay-bulk-push-ready.mjs --sku 11962 --dry-run
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { serviceClient } from "../netlify/lib/server.mjs";
import { listSku } from "../netlify/lib/ebay.mjs";
import { loadEbayAccount } from "../netlify/lib/ebay-accounts.mjs";
import { resolveBusinessPolicies } from "../netlify/lib/ebay-drafts.mjs";
import { floorListPriceCents } from "../netlify/lib/channel-autopush.mjs";
import { composeChannelDescription, parseListingSpecs } from "../netlify/lib/listing-copy.mjs";
import { ebayDescription, ebayIdentifiers } from "../netlify/lib/ebay-product.mjs";
import { ebayNeverList, ebayReviewReason } from "../netlify/lib/ebay-exclusion.mjs";
import { prohibitedReason } from "../netlify/lib/ebay-eligibility.mjs";
import {
  CLEARANCE_FOOTER_TEXT,
  clearanceCondition,
} from "../netlify/lib/ebay-listing-standards.mjs";
import {
  listingMeasures,
  refreshCategoryAspects,
  refreshCategoryConditions,
  resolveFloorCategory,
} from "../netlify/lib/ebay-catalog.mjs";
import { ebayModelValue, fillAspects } from "../netlify/lib/ebay-aspects.mjs";
import { listingConditionPayload } from "../netlify/lib/ebay-conditions.mjs";
import { ebayItemViewUrl } from "../netlify/lib/ebay-env.mjs";

const SELLING_USER = "ikonikdeals2026";
const MAX_RETRIES = 3;
const DEFAULT_PACE_MS = { min: 8_000, max: 15_000 };
const DEFAULT_BOX = { length_in: 14, width_in: 11, height_in: 4, weight_lb: 3 };

const BLOCKED =
  /(refrigerat|dishwasher|freezer|mattress|bed\s*frames?|deep\s*fryer|\bscooter\b|holiday\s*living|christmas\s*lights?|(?:led|string|icicle|fairy)\s+lights?)/i;
const RISKY =
  /\b(lithium|li-?ion|battery\s*pack|powerwall|e-?bike|hoverboard|vape|firearm|ammunition|drone\s*battery)\b/i;

function arg(name, fallback = null) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1] ?? true;
  return fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function paceDelay() {
  const min = DEFAULT_PACE_MS.min;
  const max = DEFAULT_PACE_MS.max;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function titleForUnit(unit) {
  if (unit.ebay_title && String(unit.ebay_title).trim()) {
    let t = String(unit.ebay_title).trim();
    if (!/\bSKU\b/i.test(t)) t = `${t} | SKU ${unit.sku}`;
    return t.length > 80 ? `${t.slice(0, 77)}...` : t;
  }
  const name =
    [unit.brand, unit.model].filter((p) => String(p || "").trim()).join(" ").trim() ||
    unit.title ||
    `SKU ${unit.sku}`;
  // Prefer identity over junk model duplicates.
  let title = `${name} — Open box | SKU ${unit.sku}`;
  if (title.length > 80) title = `${name} | SKU ${unit.sku}`;
  if (title.length > 80) title = `${title.slice(0, 77)}...`;
  return title;
}

function descriptionForUnit(unit) {
  const grade = String(unit.condition || "").trim() || "Open box";
  const base = composeChannelDescription({
    listingBody: unit.listing_body,
    brand: unit.brand,
    model: unit.model,
    title: unit.title,
    specs: parseListingSpecs(unit.listing_specs),
    condition: grade,
    testStatus: unit.test_status,
    defectNotes: unit.defect_notes,
    sku: unit.sku,
  });
  const cleaned = String(base)
    .replace(/\nSold as-is\. Local pickup unless arranged\.\s*$/i, "")
    .trim();
  const body = [
    "Sold by Open Box Industries (Penryn, CA).",
    cleaned,
    "",
    `Condition: ${grade} (open-box clearance).`,
    "If this item is not as described, message us on eBay and we will make it right with a replacement when available.",
    "Buyer pays calculated shipping. Local pickup also available at our Penryn store.",
    "Sold as-is. No returns.",
    "",
    CLEARANCE_FOOTER_TEXT,
  ].join("\n");
  return ebayDescription(body, unit.sku);
}

function estimateBox(unit) {
  const length_in = Number(unit?.package_length_in);
  const width_in = Number(unit?.package_width_in);
  const height_in = Number(unit?.package_height_in);
  const weight_lb = Number(unit?.package_weight_lb);
  if (length_in > 0 && width_in > 0 && height_in > 0 && weight_lb > 0) {
    return { length_in, width_in, height_in, weight_lb, assumed: false };
  }
  const blob = [unit?.title, unit?.brand, unit?.model, unit?.category].filter(Boolean).join(" ").toLowerCase();
  let box = { ...DEFAULT_BOX };
  if (/curtain|drape|panel|sheer/.test(blob)) box = { length_in: 16, width_in: 12, height_in: 3, weight_lb: 3.5 };
  else if (/pillow|cushion/.test(blob)) box = { length_in: 18, width_in: 14, height_in: 6, weight_lb: 2.5 };
  else if (/blanket|throw|comforter|quilt/.test(blob)) box = { length_in: 18, width_in: 14, height_in: 8, weight_lb: 5 };
  else if (/candle/.test(blob)) box = { length_in: 12, width_in: 10, height_in: 8, weight_lb: 4 };
  else if (/diaper|wipe/.test(blob)) box = { length_in: 18, width_in: 12, height_in: 10, weight_lb: 8 };
  else if (/cart|rack|tote|storage/.test(blob)) box = { length_in: 24, width_in: 16, height_in: 10, weight_lb: 12 };
  else if (/pool|inflatable/.test(blob)) box = { length_in: 16, width_in: 12, height_in: 6, weight_lb: 4 };
  return { ...box, assumed: true };
}

function packagePayload(box) {
  return {
    dimensions: {
      length: String(box.length_in),
      width: String(box.width_in),
      height: String(box.height_in),
      unit: "INCH",
    },
    weight: { value: String(box.weight_lb), unit: "POUND" },
  };
}

function skipReason(unit) {
  if (!unit) return "missing_unit";
  if (ebayNeverList(unit)) return "ebay_never_list";
  if (ebayReviewReason(unit)) return `ebay_review:${ebayReviewReason(unit)}`;
  if (unit.state !== "available") return `state_${unit.state}`;
  if (unit.is_test) return "test_unit";
  if (!(Number(unit.ask_cents) > 0)) return "no_price";
  const banned = prohibitedReason(unit);
  if (banned) return `prohibited_${banned}`;
  const blob = [unit.title, unit.brand, unit.model, unit.category, unit.ebay_title].filter(Boolean).join(" ");
  const checked = blob.replace(/\bmattress\s+(?:pads?|toppers?|protectors?)\b/gi, " ");
  if (BLOCKED.test(checked)) return "blocked_category_or_title";
  if (RISKY.test(blob)) return "risky_electronics_battery";
  return null;
}

async function loadAssigned(sb, storeId, sku) {
  const { data, error } = await sb
    .from("unit_channel_categories")
    .select("category_id,attributes,source,enabled")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .eq("channel", "ebay")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function prepareMeta(storeId, unit, assigned) {
  const categoryId = String(assigned?.category_id || "");
  if (!categoryId) throw new Error("missing_ebay_category");
  const floor = resolveFloorCategory(unit.category);
  const defs = await refreshCategoryAspects(categoryId);
  const conditions = await refreshCategoryConditions(categoryId);
  const open = clearanceCondition(conditions, unit.condition || "Open box");
  if (!open) throw new Error(`no_open_box_or_honest_condition for category ${categoryId}`);
  const conditionPayload =
    listingConditionPayload({
      conditionId: String(open.conditionId),
      conditionEnum: open.conditionEnum || null,
      name: open.name,
    }) || { conditionId: String(open.conditionId) };

  const specs = listingMeasures(unit);
  const filled = fillAspects(defs, unit, specs, {
    categoryDefaults: floor?.defaults || {},
    standalone: floor?.standalone || false,
    categoryName: floor?.name || null,
    title: unit.title,
  });
  const aspects = {};
  for (const [name, value] of Object.entries(filled.aspects || {})) {
    const text = Array.isArray(value) ? value[0] : String(value || "");
    if (text) aspects[name] = [text];
  }
  // Prefer saved attributes from Floor.
  for (const [name, value] of Object.entries(assigned?.attributes || {})) {
    const text = Array.isArray(value) ? value[0] : String(value || "");
    if (text && text.trim()) aspects[name] = [text.trim()];
  }
  for (const row of filled.filled || []) {
    if (row.required && !aspects[row.name]) aspects[row.name] = ["Does not apply"];
  }
  const ids = ebayIdentifiers(unit, aspects);
  if (!ids.validBrand) {
    const brand = String(unit.brand || unit.title || "Unbranded").trim().slice(0, 65) || "Unbranded";
    aspects.Brand = [brand];
  } else {
    aspects.Brand = [ids.brand];
  }
  aspects.MPN = [ids.mpn || "Does Not Apply"];
  aspects.Model = [ebayModelValue(unit, parseListingSpecs(unit.listing_specs) || {})];
  // Never invent UPC.
  if (aspects.UPC && /does\s*not\s*apply/i.test(String(aspects.UPC[0] || ""))) {
    /* keep */
  }

  return {
    categoryId,
    aspects,
    conditionPayload,
    conditionName: open.name,
    conditionReason: open.reason,
  };
}

async function ensureDims(sb, storeId, unit, box) {
  if (!box.assumed) return unit;
  const patch = {
    package_length_in: box.length_in,
    package_width_in: box.width_in,
    package_height_in: box.height_in,
    package_weight_lb: box.weight_lb,
    dims_source: unit.dims_source || "estimated",
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("units").update(patch).eq("store_id", storeId).eq("sku", unit.sku);
  if (error) throw new Error(`dims_update_failed: ${error.message}`);
  return { ...unit, ...patch };
}

async function pushOne(storeId, sku, { dryRun = false, policies }) {
  const sb = serviceClient();
  const { data: unit, error } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (error) throw new Error(error.message);
  const blocked = skipReason(unit);
  if (blocked) return { sku, ok: false, skipped: true, reason: blocked };

  const { data: live } = await sb
    .from("listings")
    .select("listing_id,status,url")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .eq("channel", "ebay")
    .eq("status", "listed")
    .maybeSingle();
  if (live) {
    return { sku, ok: false, skipped: true, reason: "already_listed", listingId: live.listing_id, url: live.url };
  }

  const { count: photoCount, error: photoErr } = await sb
    .from("photos")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("sku", sku);
  if (photoErr) throw new Error(photoErr.message);
  if (!(photoCount > 0)) return { sku, ok: false, skipped: true, reason: "no_unit_photo" };

  const assigned = await loadAssigned(sb, storeId, sku);
  if (!assigned?.category_id) return { sku, ok: false, skipped: true, reason: "missing_ebay_category" };

  let box = estimateBox(unit);
  const priced = floorListPriceCents(unit);
  if (!priced) return { sku, ok: false, skipped: true, reason: "no_price" };

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const unitForMeta = box.assumed ? await ensureDims(sb, storeId, unit, box) : unit;
      box = estimateBox(unitForMeta);
      const meta = await prepareMeta(storeId, unitForMeta, assigned);
      const draft = {
        title: titleForUnit(unitForMeta),
        description: descriptionForUnit(unitForMeta),
        priceCents: priced,
        quantity: Math.max(1, Math.trunc(Number(unitForMeta.qty_on_hand) || 1)),
        categoryId: meta.categoryId,
        aspects: meta.aspects,
        conditionPayload: meta.conditionPayload,
        package: packagePayload(box),
        pickupOnly: true,
        policies: {
          payment: policies.payment,
          returnP: policies.returnP,
          fulfillment: policies.fulfillmentCalculatedPickup,
        },
        bestOfferEnabled: false,
      };
      if (dryRun) {
        return {
          sku,
          ok: true,
          dry_run: true,
          price_cents: priced,
          floor_cents: unit.ask_cents,
          dims_assumed: box.assumed,
          box,
          condition: meta.conditionName,
          title: draft.title,
          categoryId: meta.categoryId,
        };
      }
      const listed = await listSku(storeId, sku, draft);
      return {
        sku,
        ok: true,
        listingId: listed.listingId,
        offerId: listed.offerId,
        viewUrl: listed.viewUrl || ebayItemViewUrl(listed.listingId),
        price_cents: priced,
        floor_cents: unit.ask_cents,
        dims_assumed: box.assumed,
        box,
        condition: meta.conditionName,
        title: draft.title,
        attempt,
      };
    } catch (err) {
      lastErr = err;
      const message = String(err?.message || err);
      // Aspect / condition retries: refresh assigned attributes once.
      if (/aspect|specific|condition|Brand needed|25002|25019|25058|25059/i.test(message) && attempt < MAX_RETRIES) {
        await sleep(1500);
        continue;
      }
      if (/package|weight|dimension|dims/i.test(message) && attempt < MAX_RETRIES) {
        box = { ...DEFAULT_BOX, assumed: true };
        await ensureDims(sb, storeId, unit, box);
        continue;
      }
      break;
    }
  }
  return {
    sku,
    ok: false,
    error: String(lastErr?.message || lastErr).slice(0, 800),
    status: lastErr?.status || null,
    floor_cents: unit?.ask_cents,
  };
}

async function main() {
  const storeId = process.env.STORE_ID || (existsSync("/tmp/store_id.txt") ? readFileSync("/tmp/store_id.txt", "utf8").trim() : "");
  if (!storeId) throw new Error("STORE_ID required");
  process.env.STORE_ID = storeId;

  const dryRun = process.argv.includes("--dry-run");
  const one = arg("--sku");
  const skusFile = arg("--skus-file");
  const resultFile = arg("--result-file", "/tmp/ebay_push_results.jsonl");
  const startAt = Number(arg("--start", "0")) || 0;
  const limit = Number(arg("--limit", "0")) || 0;

  let skus = [];
  if (one && one !== true) skus = [String(one)];
  else if (skusFile && skusFile !== true) {
    const raw = JSON.parse(readFileSync(skusFile, "utf8"));
    skus = Array.isArray(raw) ? raw.map((x) => String(x.sku || x)) : [];
  } else {
    throw new Error("Pass --sku or --skus-file");
  }
  if (startAt) skus = skus.slice(startAt);
  if (limit > 0) skus = skus.slice(0, limit);

  const account = await loadEbayAccount(storeId, { username: SELLING_USER });
  if (String(account.role) !== "selling" || String(account.status) !== "connected") {
    throw new Error(`selling account ${SELLING_USER} not connected (role=${account.role} status=${account.status})`);
  }
  const policies = await resolveBusinessPolicies(storeId);
  if (!policies.fulfillmentCalculatedPickup) {
    throw new Error("missing calculated+local-pickup fulfillment policy");
  }

  console.log(JSON.stringify({
    storeId,
    account: account.username,
    dryRun,
    total: skus.length,
    calculatedPickup: policies.fulfillmentCalculatedPickup,
  }));

  const summary = { ok: 0, skipped: 0, failed: 0, results: [] };
  for (let i = 0; i < skus.length; i++) {
    const sku = skus[i];
    const started = Date.now();
    let result;
    try {
      result = await pushOne(storeId, sku, { dryRun, policies });
    } catch (err) {
      result = { sku, ok: false, error: String(err?.message || err).slice(0, 800) };
    }
    summary.results.push(result);
    if (result.ok) summary.ok += 1;
    else if (result.skipped) summary.skipped += 1;
    else summary.failed += 1;
    appendFileSync(resultFile, `${JSON.stringify({ ...result, at: new Date().toISOString(), i })}\n`);
    console.log(JSON.stringify({ i, n: skus.length, ms: Date.now() - started, ...result }));
    writeFileSync(resultFile.replace(/\.jsonl$/, ".summary.json"), JSON.stringify(summary, null, 2));
    if (i < skus.length - 1 && !dryRun && result.ok) await sleep(paceDelay());
    else if (i < skus.length - 1 && !result.ok && !result.skipped) await sleep(2500);
  }
  console.log(JSON.stringify({ done: true, ok: summary.ok, skipped: summary.skipped, failed: summary.failed }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
