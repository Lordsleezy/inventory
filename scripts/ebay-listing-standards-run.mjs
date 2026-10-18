/**
 * In-place listing standards for ikonikdeals2026 only.
 * Revises condition and the clearance footer. Queues catalog photos until a person confirms them.
 * Never ends a listing. Never touches pgg124-5, price, title, quantity, shipping, or category.
 *
 *   node scripts/ebay-listing-standards-run.mjs
 *   node scripts/ebay-listing-standards-run.mjs --apply-photos
 */
import fs from "node:fs";
import path from "node:path";

function loadEnv() {
  const candidates = [
    path.join(process.env.TEMP || "", "netlify-env-inventoryobi.json"),
    path.join(process.cwd(), ".env"),
  ];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    if (file.endsWith(".json")) {
      const rows = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const row of rows) {
        if (!row?.key || process.env[row.key]) continue;
        const values = Array.isArray(row.values) ? row.values : [];
        const picked = values.find((v) => v?.context === "production") || values[0];
        if (picked?.value != null && picked.value !== "") process.env[row.key] = String(picked.value);
      }
      continue;
    }
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^"|"$/g, "");
    }
  }
}

loadEnv();

const { serviceClient } = await import("../netlify/lib/server.mjs");
const { userTokenForAccount } = await import("../netlify/lib/ebay-accounts.mjs");
const { getMyEbaySellingActive, getSellerUsername, getTradingItem, reviseFixedPriceStandards, uploadSiteHostedPicture } = await import("../netlify/lib/ebay-trading.mjs");
const { fetchLiveConditions } = await import("../netlify/lib/ebay-catalog.mjs");
const { ebayFetch } = await import("../netlify/lib/ebay.mjs");
const { listingConditionPayload } = await import("../netlify/lib/ebay-conditions.mjs");
const { confirmCatalogVisual, matchCatalogPhoto } = await import("../netlify/lib/ebay-catalog-photo.mjs");
const {
  CLEARANCE_FOOTER_MARK,
  PERSONAL_USER,
  SELLING_USER,
  appendClearanceFooter,
  clearanceCondition,
  isCollectible,
} = await import("../netlify/lib/ebay-listing-standards.mjs");

const APPLY_PHOTOS = process.argv.includes("--apply-photos");
const OUT = path.join(process.env.TEMP || ".", "ebay-listing-standards");
fs.mkdirSync(OUT, { recursive: true });
const STATE_PATH = path.join(OUT, "state.json");
const CLAIMS_PATH = path.join(process.cwd(), "scripts", "ebay-revision-claims.json");
const PHOTO_DIR = path.join(OUT, "photo-review");
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : {
  revised: {},
  photos: {},
  errors: [],
  counts: { condition: 0, footer: 0, photo: 0, skipped_photo: 0, condition_left: 0 },
};

function save() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  fs.appendFileSync(path.join(OUT, "run.log"), text + "\n");
  console.log(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function claim(itemId, fields) {
  const current = fs.existsSync(CLAIMS_PATH) ? JSON.parse(fs.readFileSync(CLAIMS_PATH, "utf8")) : { claims: {} };
  const now = Date.now();
  const existing = current.claims?.[itemId];
  if (existing && existing.agent && existing.agent !== "listing-standards") {
    const age = now - Date.parse(existing.at || 0);
    const overlap = (existing.fields || []).some((field) => fields.includes(field));
    if (overlap && age < 30 * 60 * 1000) return false;
  }
  current.agent = "listing-standards";
  current.account = SELLING_USER;
  current.claims = current.claims || {};
  current.claims[itemId] = { agent: "listing-standards", fields, at: new Date().toISOString() };
  fs.writeFileSync(CLAIMS_PATH, JSON.stringify(current, null, 2));
  return true;
}

async function download(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`image_${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

try {
  const sb = serviceClient();
  const { data: accounts, error } = await sb.from("ebay_accounts").select("*").eq("username", SELLING_USER).eq("role", "selling").eq("status", "connected");
  if (error) throw new Error(error.message);
  const selling = (accounts || [])[0];
  if (!selling) throw new Error("ikonikdeals2026 selling account is not connected");
  if (String(selling.username).toLowerCase() !== SELLING_USER) throw new Error("refusing unexpected selling account");
  const token = await userTokenForAccount(selling);
  const username = await getSellerUsername(token);
  if (String(username).toLowerCase() !== SELLING_USER) throw new Error(`refusing token for ${username}`);
  if (String(username).toLowerCase() === PERSONAL_USER) throw new Error("refusing personal account");
  log(`account ${username} confirmed`);

  const active = await getMyEbaySellingActive(token);
  log(`active listings ${active.length}`);
  const skus = [...new Set(active.map((row) => row.sku).filter(Boolean))];
  const units = new Map();
  for (let i = 0; i < skus.length; i += 100) {
    const slice = skus.slice(i, i + 100);
    const { data, error: unitError } = await sb.from("units").select("sku,brand,model,upc,title,category,condition,defect_notes,is_collectible").eq("store_id", selling.store_id).in("sku", slice);
    if (unitError) throw new Error(unitError.message);
    for (const row of data || []) units.set(String(row.sku), row);
  }
  const conditionsByCategory = new Map();
  let consecutive = 0;
  const retry = [];

  const hint = { _account: selling, accountId: selling.id, role: "selling" };
  const market = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";

  async function reviseInventoryItem(sku, change, picked) {
    if (!sku) throw new Error("inventory listing has no SKU");
    const current = await ebayFetch(selling.store_id, "GET", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, undefined, hint);
    const offers = await ebayFetch(selling.store_id, "GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${market}&limit=20`, undefined, hint);
    const product = { ...(current?.product || {}) };
    const next = {
      availability: current?.availability,
      packageWeightAndSize: current?.packageWeightAndSize,
      product,
    };
    if (!next.availability) {
      const qty = offers?.offers?.[0]?.availableQuantity;
      if (qty == null) throw new Error("availability missing; refusing to invent a quantity");
      next.availability = { shipToLocationAvailability: { quantity: qty } };
    }
    if (current?.conditionDescription) next.conditionDescription = current.conditionDescription;
    if (change.conditionId) {
      const payload = listingConditionPayload({ conditionId: change.conditionId, name: picked?.name || "Open box" });
      if (!payload) throw new Error(`no inventory condition for ${change.conditionId}`);
      next.condition = payload.condition;
    } else if (current?.condition) {
      next.condition = current.condition;
    }
    if (change.description != null) product.description = change.description;
    if (change.pictureUrls?.length) product.imageUrls = change.pictureUrls;
    await ebayFetch(selling.store_id, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, next, hint);
    if (change.description == null) return;
    for (const offer of offers?.offers || []) {
      if (!offer?.offerId) continue;
      const body = {
        sku: offer.sku,
        marketplaceId: offer.marketplaceId,
        format: offer.format,
        availableQuantity: offer.availableQuantity,
        categoryId: offer.categoryId,
        listingDescription: change.description,
        listingPolicies: offer.listingPolicies,
        pricingSummary: offer.pricingSummary,
        listingDuration: offer.listingDuration || "GTC",
      };
      if (offer.merchantLocationKey) body.merchantLocationKey = offer.merchantLocationKey;
      if (offer.storeCategoryNames) body.storeCategoryNames = offer.storeCategoryNames;
      if (offer.tax) body.tax = offer.tax;
      await ebayFetch(selling.store_id, "PUT", `/sell/inventory/v1/offer/${offer.offerId}`, body, hint);
    }
  }

  async function conditionsFor(categoryId) {
    if (!categoryId) return [];
    if (conditionsByCategory.has(categoryId)) return conditionsByCategory.get(categoryId);
    try {
      const rows = await fetchLiveConditions(categoryId);
      conditionsByCategory.set(categoryId, rows);
      await sleep(400);
      return rows;
    } catch (err) {
      conditionsByCategory.set(categoryId, []);
      log(`conditions ${categoryId} failed ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async function reviseOne(summary, attempt) {
    const itemId = String(summary.itemId);
    if (state.revised[itemId]?.done && !APPLY_PHOTOS) return;
    const item = await getTradingItem(token, itemId);
    if (/chinese|auction/i.test(`${item.listingType || ""} ${summary.listingType || ""}`)) {
      state.revised[itemId] = { done: true, sku: summary.sku, skipped: "auction" };
      return;
    }
    await sleep(1200);
    const unit = units.get(String(item.sku || summary.sku || "")) || {};
    const collectible = isCollectible({ ...unit, title: item.title, categoryName: item.categoryName, aspects: item.aspects });
    const allowed = await conditionsFor(item.categoryId);
    const picked = collectible ? null : clearanceCondition(allowed);
    const change = { itemId };
    const fields = [];
    const record = state.revised[itemId] || { sku: item.sku || summary.sku || "", title: item.title, itemId };

    if (collectible) {
      record.condition = "left";
      record.condition_reason = "collectible";
      state.counts.condition_left += record.condition_counted ? 0 : 1;
      record.condition_counted = true;
    } else if (!picked) {
      record.condition = "left";
      record.condition_reason = allowed.length ? "no_open_box_or_new_other" : "conditions_unavailable";
      record.condition_allowed = allowed.map((row) => `${row.name} (${row.conditionId})`);
      state.counts.condition_left += record.condition_counted ? 0 : 1;
      record.condition_counted = true;
    } else if (String(item.conditionId) === String(picked.conditionId)) {
      record.condition = "already";
      record.condition_id = picked.conditionId;
      record.condition_name = picked.name;
    } else {
      change.conditionId = picked.conditionId;
      fields.push("condition");
      record.condition = picked.fallback ? "new_other" : "open_box";
      record.condition_id = picked.conditionId;
      record.condition_name = picked.name;
      record.condition_from = item.conditionId;
    }

    if (!String(item.description || "").includes(CLEARANCE_FOOTER_MARK)) {
      change.description = appendClearanceFooter(item.description || "");
      fields.push("description_footer");
    } else {
      record.footer = "already";
    }

    if (!fields.length) {
      record.done = true;
      state.revised[itemId] = record;
      return;
    }
    if (!claim(itemId, fields)) {
      record.error = "another agent claimed these fields";
      state.revised[itemId] = record;
      state.errors.push({ itemId, sku: record.sku, error: record.error });
      return;
    }
    try {
      await reviseFixedPriceStandards(token, change);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/inventory-based listing management/i.test(message)) throw err;
      await reviseInventoryItem(record.sku, change, picked);
      record.via = "inventory";
    }
    if (fields.includes("condition")) state.counts.condition += 1;
    if (fields.includes("description_footer")) state.counts.footer += 1;
    record.done = true;
    record.revised_fields = fields;
    state.revised[itemId] = record;
    log(`revised ${record.sku || "?"} ${itemId} ${fields.join("+")}`);
    consecutive = 0;
  }

  async function queuePhoto(summary) {
    const itemId = String(summary.itemId);
    if (state.photos[itemId]) return;
    const item = state.revised[itemId]?.item || null;
    const full = item || await getTradingItem(token, itemId);
    const unit = units.get(String(full.sku || summary.sku || "")) || {};
    const match = await matchCatalogPhoto({
      unit: { ...unit, title: full.title, sku: full.sku || summary.sku, category: unit.category, categoryName: full.categoryName, defect_notes: unit.defect_notes, aspects: full.aspects },
      aspects: full.aspects,
      imageUrls: full.imageUrls || summary.imageUrls || [],
      fetchJson: (apiPath) => ebayFetch(selling.store_id, "GET", apiPath, undefined, { _account: selling, accountId: selling.id, role: "selling" }),
      visualConfirm: async ({ ourUrl, catalogUrl }) => {
        const oursPath = path.join(PHOTO_DIR, `${itemId}-ours.jpg`);
        const catPath = path.join(PHOTO_DIR, `${itemId}-catalog.jpg`);
        await download(ourUrl, oursPath);
        await download(catalogUrl, catPath);
        state.photos[itemId] = { ...(state.photos[itemId] || {}), ours: oursPath, catalog: catPath };
        return confirmCatalogVisual({ ourUrl, catalogUrl });
      },
    });
    state.photos[itemId] = {
      ...(state.photos[itemId] || {}),
      sku: full.sku || summary.sku || "",
      itemId,
      matchType: match.matchType,
      epid: match.epid,
      apply: false,
      reason: match.reason,
      gtin: match.gtin || "",
      model: match.model || "",
      queued: match.apply === true,
    };
    if (!match.apply) {
      state.counts.skipped_photo += 1;
      log(`photo skip ${state.photos[itemId].sku || itemId} ${match.reason}`);
      return;
    }
    log(`photo queued for review ${state.photos[itemId].sku} ${match.matchType} ${match.epid}`);
  }

  if (APPLY_PHOTOS) {
    const approved = JSON.parse(fs.readFileSync(path.join(OUT, "photo-approved.json"), "utf8"));
    for (const row of approved) {
      if (state.photos[row.itemId]?.applied) continue;
      try {
        if (!claim(row.itemId, ["pictures"])) throw new Error("another agent claimed pictures");
        const item = await getTradingItem(token, row.itemId);
        let urls = row.imageUrls;
        try {
          await reviseFixedPriceStandards(token, { itemId: row.itemId, pictureUrls: urls });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!/picture|photo|image/i.test(message)) throw err;
          const hosted = [];
          for (const url of row.catalogImages || []) {
            hosted.push(await uploadSiteHostedPicture(token, url));
            await sleep(1500);
          }
          const existing = (item.imageUrls || []).filter(Boolean);
          urls = existing.length ? [hosted[0], ...existing].slice(0, 12) : hosted.slice(0, 2);
          if (urls.length < 2) throw new Error("could not keep two photos");
          await reviseFixedPriceStandards(token, { itemId: row.itemId, pictureUrls: urls });
        }
        state.photos[row.itemId] = { ...(state.photos[row.itemId] || {}), applied: true, imageUrls: urls };
        state.counts.photo += 1;
        log(`photo applied ${row.sku} ${row.itemId}`);
        consecutive = 0;
      } catch (err) {
        consecutive += 1;
        const message = err instanceof Error ? err.message : String(err);
        state.errors.push({ itemId: row.itemId, sku: row.sku, error: message });
        log(`photo error ${row.itemId} ${message}`);
        if (consecutive >= 3) {
          log("three photo failures, backing off 3 minutes");
          await sleep(180000);
          consecutive = 0;
        }
      }
      save();
      await sleep(6000);
    }
  } else {
    for (const summary of active) {
      try {
        await reviseOne(summary, 1);
      } catch (err) {
        consecutive += 1;
        const message = err instanceof Error ? err.message : String(err);
        log(`error ${summary.sku || summary.itemId} ${message}`);
        state.errors.push({ itemId: summary.itemId, sku: summary.sku, error: message });
        if (attemptOk(message) && !retry.includes(summary.itemId)) retry.push(summary);
        if (consecutive >= 3) {
          log("three failures in a row, backing off 3 minutes");
          await sleep(180000);
          consecutive = 0;
        }
      }
      save();
      await sleep(5500);
    }
    for (const summary of retry) {
      try {
        await reviseOne(summary, 2);
        await sleep(8000);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`retry failed ${summary.itemId} ${message}`);
        state.errors.push({ itemId: summary.itemId, sku: summary.sku, error: `retry: ${message}` });
        save();
      }
    }
    consecutive = 0;
    for (const summary of active) {
      if (String(summary.listingType || "").toLowerCase().includes("chinese")) continue;
      try {
        await queuePhoto(summary);
      } catch (err) {
        consecutive += 1;
        const message = err instanceof Error ? err.message : String(err);
        state.photos[summary.itemId] = { sku: summary.sku, itemId: summary.itemId, apply: false, reason: `error:${message}` };
        state.counts.skipped_photo += 1;
        log(`photo error ${summary.sku || summary.itemId} ${message}`);
        if (consecutive >= 3) {
          log("three photo lookups failed, backing off 3 minutes");
          await sleep(180000);
          consecutive = 0;
        }
      }
      save();
      await sleep(2000);
    }
  }
  const doneIds = new Set(Object.entries(state.revised).filter(([, row]) => row.done).map(([id]) => String(id)));
  state.errors = state.errors.filter((row) => !doneIds.has(String(row.itemId)));
  const rows = Object.values(state.revised);
  state.counts.condition = rows.filter((row) => (row.revised_fields || []).includes("condition")).length;
  state.counts.footer = rows.filter((row) => (row.revised_fields || []).includes("description_footer")).length;
  state.counts.condition_left = rows.filter((row) => row.condition === "left").length;
  state.counts.photo = Object.values(state.photos).filter((row) => row.applied).length;
  state.counts.skipped_photo = Object.values(state.photos).filter((row) => row.reason && !row.applied && !row.queued).length;
  state.counts.photo_queued = Object.values(state.photos).filter((row) => row.queued && !row.applied).length;
  save();
  log(`done ${JSON.stringify(state.counts)} errors ${state.errors.length}`);
} catch (err) {
  log(`fatal ${err instanceof Error ? err.message : err}`);
  save();
  process.exit(1);
}

function attemptOk(message) {
  return /timeout|throttle|rate|503|502|too many|temporarily/i.test(message);
}
