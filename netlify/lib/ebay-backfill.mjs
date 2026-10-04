import { serviceClient, requireEnv } from "./server.mjs";
import { ebayDraftEligibility } from "./ebay-eligibility.mjs";
import { loadEbaySettings, repriceDraft } from "./ebay-drafts.mjs";
import { parseListingSpecs } from "./listing-copy.mjs";
import { lookupProductSpecs, enrichVideo, tokenCost } from "./video-scan.mjs";

const KEY = "ebay_spec_backfill";
const SEARCH_CAP = 4500;
const dimensionKeys = [
  "product_height_in", "product_width_in", "product_depth_in", "product_weight_lb",
  "package_length_in", "package_width_in", "package_height_in", "package_weight_lb",
];

function measure(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 10000 ? Math.round(n * 100) / 100 : null;
}

function cleanModel(value) {
  const model = String(value || "").trim();
  return /\d/.test(model) && !/^\d{5,}$/.test(model) ? model : "";
}

function goodDescription(value, title) {
  const text = String(value || "").trim();
  return text.length > String(title || "").length + 25 ? text : "";
}

function emptyObject(value) {
  return !value || typeof value !== "object" || !Object.keys(value).length;
}

function needsSpecs(unit) {
  const boxMissing = [unit.package_length_in, unit.package_width_in, unit.package_height_in, unit.package_weight_lb]
    .some((n) => !(Number(n) > 0));
  const specs = parseListingSpecs(unit.listing_specs) || {};
  const aspectsMissing = emptyObject(unit.ebay_item_specifics) && emptyObject(specs.ebay_aspects);
  return boxMissing || aspectsMissing;
}

async function readJob(sb, storeId) {
  const { data, error } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", KEY).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.value && typeof data.value === "object" ? data.value : { status: "idle", processed: 0, total: 0, searched: 0, reused: 0, cost_usd: 0, attempted: [] };
}

async function writeJob(sb, storeId, job) {
  const { error } = await sb.from("store_settings").upsert(
    { store_id: storeId, key: KEY, value: job },
    { onConflict: "store_id,key" },
  );
  if (error) throw new Error(error.message);
}

export async function backfillStatus(storeId) {
  const sb = serviceClient();
  const job = await readJob(sb, storeId);
  return {
    status: job.status || "idle",
    processed: job.processed || 0,
    total: job.total || 0,
    searched: job.searched || 0,
    reused: job.reused || 0,
    cost_usd: job.cost_usd || 0,
    filled_box: job.filled_box || 0,
    note: job.note || "",
  };
}

async function monthSearches(sb, storeId) {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const { data, error } = await sb.from("video_scan_jobs").select("search_queries").eq("store_id", storeId).gte("created_at", start.toISOString());
  if (error) throw new Error(error.message);
  return (data || []).reduce((sum, row) => sum + (Number(row.search_queries) || 0), 0);
}

async function candidates(sb, storeId, settings, attempted) {
  const skip = new Set(attempted || []);
  const units = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await sb.from("units").select("*").eq("store_id", storeId).eq("state", "available").gt("ask_cents", 0).range(from, from + 499);
    if (error) throw new Error(error.message);
    units.push(...(data || []));
    if (!data || data.length < 500) break;
  }
  const skus = units.map((unit) => unit.sku);
  const photos = new Set();
  for (let i = 0; i < skus.length; i += 200) {
    const { data, error } = await sb.from("photos").select("sku").eq("store_id", storeId).in("sku", skus.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const row of data || []) photos.add(row.sku);
  }
  return units.filter((unit) => {
    if (skip.has(unit.sku) || !photos.has(unit.sku) || !needsSpecs(unit)) return false;
    return ebayDraftEligibility({ ...unit, photo_count: 1 }, settings).ok;
  });
}

function acceptDimensions(found) {
  const sources = found.dimension_sources && typeof found.dimension_sources === "object" ? found.dimension_sources : {};
  const types = found.dimension_types && typeof found.dimension_types === "object" ? found.dimension_types : {};
  const dimensions = Object.fromEntries(dimensionKeys.map((key) => [key, measure(found[key])]));
  return Object.fromEntries(Object.entries(dimensions).filter(([key, value]) => value !== null && (
    (types[key] === "estimated" && String(sources[key] || "").startsWith("estimated"))
    || (types[key] === (key.startsWith("package_") ? "verified_shipping" : "verified_product") && String(sources[key] || "").startsWith("https://"))
  )));
}

function applyFound(unit, found) {
  const guarded = unit.dims_source === "measured" || unit.dims_source === "verified";
  const accepted = guarded ? {} : acceptDimensions(found);
  const types = found.dimension_types || {};
  const sources = found.dimension_sources || {};
  const specs = parseListingSpecs(unit.listing_specs) || {};
  const dimsSources = { ...(specs.dims_sources || {}) };
  const patch = {};
  for (const [key, value] of Object.entries(accepted)) {
    if (unit[key] != null) continue;
    patch[key] = value;
    if (!dimsSources[key]) dimsSources[key] = `${types[key]}: ${String(sources[key] || "")}`;
    if (key.startsWith("product_")) {
      const short = key.slice("product_".length);
      if (specs[short] == null) specs[short] = value;
    }
  }
  if (Object.keys(patch).some((key) => dimensionKeys.includes(key)) && !unit.dims_source) {
    patch.dims_source = Object.keys(patch).some((key) => types[key] === "estimated") ? "estimated" : "verified";
  }
  if (!String(unit.brand || "").trim() && String(found.ebay_item_specifics?.Brand || "").trim()) {
    patch.brand = String(found.ebay_item_specifics.Brand).trim();
  }
  const model = cleanModel(found.manufacturer_model);
  if (!String(unit.model || "").trim() && model) patch.model = model;
  const desc = goodDescription(found.description, unit.title);
  if (!String(unit.listing_body || "").trim() && desc) patch.listing_body = desc;
  const aspects = { ...(unit.ebay_item_specifics || {}) };
  let aspectAdded = false;
  for (const [name, value] of Object.entries(found.ebay_item_specifics || {})) {
    const text = String(value || "").trim();
    if (!text || String(aspects[name] || "").trim()) continue;
    if (/^mpn$/i.test(name) && /^\d{5,}$/.test(text)) continue;
    aspects[name] = text;
    aspectAdded = true;
  }
  if (model && !aspects.MPN) { aspects.MPN = model; aspectAdded = true; }
  const ebayAspects = { ...(specs.ebay_aspects || {}), ...aspects };
  if (aspectAdded || Object.keys(patch).some((key) => key.startsWith("product_"))) {
    patch.listing_specs = { ...specs, dims_sources: dimsSources, ebay_aspects: ebayAspects };
    patch.ebay_item_specifics = aspects;
  } else if (Object.keys(dimsSources).length !== Object.keys(specs.dims_sources || {}).length) {
    patch.listing_specs = { ...specs, dims_sources: dimsSources, ebay_aspects: ebayAspects };
  }
  return patch;
}

function siteBase() {
  return (process.env.URL || "https://inventoryobi.netlify.app").replace(/\/$/, "");
}

export async function kickBackfill(storeId) {
  const res = await fetch(`${siteBase()}/.netlify/functions/ebay-spec-backfill-background`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ storeId }),
  });
  if (!res.ok && res.status !== 202) throw new Error(`Backfill could not start (${res.status})`);
}

export async function startBackfill(storeId) {
  if (process.env.EBAY_BACKGROUND_WORK !== "on") return { status: "paused", reason: "background work is paused" };
  const sb = serviceClient();
  const settings = await loadEbaySettings(storeId);
  const current = await readJob(sb, storeId);
  if (current.status === "running" && Date.now() - Date.parse(current.updated_at || 0) < 90_000) return backfillStatus(storeId);
  const todo = await candidates(sb, storeId, settings, current.attempted || []);
  const job = {
    ...current,
    status: "running",
    total: (current.processed || 0) + todo.length,
    processed: current.processed || 0,
    searched: current.searched || 0,
    reused: current.reused || 0,
    cost_usd: current.cost_usd || 0,
    input_tokens: current.input_tokens || 0,
    output_tokens: current.output_tokens || 0,
    filled_box: current.filled_box || 0,
    attempted: current.attempted || [],
    errors: (current.errors || []).slice(-20),
    note: "",
    handoff: true,
    started_at: current.started_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await writeJob(sb, storeId, job);
  await kickBackfill(storeId);
  return backfillStatus(storeId);
}

export async function resumeBackfillIfStale(storeId) {
  const sb = serviceClient();
  const job = await readJob(sb, storeId);
  if (job.status !== "running") return;
  if (Date.now() - Date.parse(job.updated_at || 0) < 3 * 60_000) return;
  job.handoff = true;
  job.updated_at = new Date().toISOString();
  await writeJob(sb, storeId, job);
  await kickBackfill(storeId);
}

export async function runBackfill(storeId, { maxMs = 11 * 60 * 1000 } = {}) {
  if (process.env.EBAY_BACKGROUND_WORK !== "on") return;
  const sb = serviceClient();
  const worker = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let job = await readJob(sb, storeId);
  if (job.status !== "running") return job;
  const fresh = Date.now() - Date.parse(job.updated_at || 0) < 90_000;
  if (job.worker && job.worker !== worker && fresh && !job.handoff) return job;
  job.worker = worker;
  job.handoff = false;
  job.updated_at = new Date().toISOString();
  await writeJob(sb, storeId, job);
  const started = Date.now();
  const settings = await loadEbaySettings(storeId);
  let lastError = "";
  let sameError = 0;
  while (Date.now() - started < maxMs) {
    const month = await monthSearches(sb, storeId);
    if (month + (job.searched || 0) >= SEARCH_CAP) {
      job.status = "paused";
      job.note = "Stopped before the monthly grounded-search cap.";
      job.updated_at = new Date().toISOString();
      await writeJob(sb, storeId, job);
      return job;
    }
    const todo = await candidates(sb, storeId, settings, job.attempted || []);
    job.total = (job.processed || 0) + todo.length;
    if (!todo.length) {
      job.status = "done";
      job.note = "";
      job.updated_at = new Date().toISOString();
      await writeJob(sb, storeId, job);
      return job;
    }
    const unit = todo[0];
    job.updated_at = new Date().toISOString();
    await writeJob(sb, storeId, job);
    try {
      const identity = { brand: unit.brand, title: unit.title, model: cleanModel(unit.model) };
      const research = await lookupProductSpecs(sb, { store_id: storeId }, identity);
      const detail = await enrichVideo(null, "", identity, { research, ebayAspects: [] });
      const patch = applyFound(unit, detail.result || {});
      const hadBox = [unit.package_length_in, unit.package_width_in, unit.package_height_in, unit.package_weight_lb].every((n) => Number(n) > 0);
      if (Object.keys(patch).length) {
        patch.updated_at = new Date().toISOString();
        const saved = await sb.from("units").update(patch).eq("store_id", storeId).eq("sku", unit.sku);
        if (saved.error) throw new Error(saved.error.message);
        await repriceDraft(storeId, unit.sku);
      }
      const afterBox = hadBox || ["package_length_in", "package_width_in", "package_height_in", "package_weight_lb"].every((key) => Number(patch[key] ?? unit[key]) > 0);
      if (!hadBox && afterBox) job.filled_box = (job.filled_box || 0) + 1;
      job.searched = (job.searched || 0) + (research.queries || 0);
      if (research.reused) job.reused = (job.reused || 0) + 1;
      job.input_tokens = (job.input_tokens || 0) + (research.input || 0) + (detail.input || 0);
      job.output_tokens = (job.output_tokens || 0) + (research.output || 0) + (detail.output || 0);
      job.cost_usd = tokenCost(job.input_tokens, job.output_tokens);
      job.attempted = [...(job.attempted || []), unit.sku];
      job.processed = (job.processed || 0) + 1;
      job.updated_at = new Date().toISOString();
      await writeJob(sb, storeId, job);
      console.info("ebay_spec_backfill", JSON.stringify({
        sku: unit.sku, searches: research.queries || 0, reused: Boolean(research.reused),
        cost_usd: job.cost_usd, fields: Object.keys(patch),
      }));
      lastError = "";
      sameError = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sameError = message === lastError ? sameError + 1 : 1;
      lastError = message;
      job.errors = [...(job.errors || []), { sku: unit.sku, error: message.slice(0, 180) }].slice(-20);
      job.updated_at = new Date().toISOString();
      if (sameError >= 2) {
        job.status = "paused";
        job.note = message.slice(0, 300);
        await writeJob(sb, storeId, job);
        return job;
      }
      job.attempted = [...(job.attempted || []), unit.sku];
      job.processed = (job.processed || 0) + 1;
      await writeJob(sb, storeId, job);
    }
  }
  job.handoff = true;
  job.updated_at = new Date().toISOString();
  await writeJob(sb, storeId, job);
  await kickBackfill(storeId);
  return job;
}
