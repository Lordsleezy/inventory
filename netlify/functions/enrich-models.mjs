import { serviceClient } from "../lib/server.mjs";
import { findExactModel, photoBuffers } from "../lib/model-lookup.mjs";

const fail = (result, label) => { if (result.error) throw new Error(`${label}: ${result.error.message}`); return result.data; };
const photoPath = (row, index) => `${row.brand_key.replace(/[^a-z0-9]+/g, "-")}/${row.model.replace(/[^a-z0-9.-]+/gi, "-").toUpperCase()}/model-enriched-${String(index).padStart(2, "0")}.webp`;

async function hasUnitPhotos(sb, row) {
  const units = fail(await sb.from("units").select("store_id,sku,listing_specs").ilike("brand", row.brand).ilike("model", row.model), "units");
  if (!units.length) return false;
  const photos = fail(await sb.from("photos").select("store_id,sku").in("sku", units.map((u) => u.sku)), "photos");
  return units.some((u) => photos.some((p) => p.store_id === u.store_id && p.sku === u.sku));
}

async function existingProfessionalPhotos(sb, row) {
  const units = fail(await sb.from("units").select("listing_specs").ilike("brand", row.brand).ilike("model", row.model), "units");
  const models = new Set([row.model, ...units.map((u) => u.listing_specs?.matched_model).filter(Boolean)]);
  for (const model of models) {
    const photos = fail(await sb.from("manufacturer_photos").select("id").ilike("brand", row.brand).ilike("model", model).limit(1), "manufacturer_photos");
    if (photos.length) return true;
  }
  return false;
}

async function savePhoto(sb, row, source, imageUrl, index) {
  const path = photoPath(row, index);
  const buffers = await photoBuffers(imageUrl);
  const stem = path.replace(/\.webp$/, "");
  for (const [target, bytes] of [[path, buffers.original], [stem.replace(/\/model-enriched-/, "/web/400/model-enriched-") + ".webp", buffers.small], [stem.replace(/\/model-enriched-/, "/web/1200/model-enriched-") + ".webp", buffers.large]]) {
    fail(await sb.storage.from("manufacturer-photos").upload(target, bytes, { contentType: "image/webp", cacheControl: "31536000", upsert: true }), `upload ${target}`);
  }
  fail(await sb.from("manufacturer_photos").upsert({ brand: row.brand, model: row.model, path, source_url: source, sort_order: index }, { onConflict: "path" }), "manufacturer_photo_row");
}

async function processRow(sb, row) {
  const key = { brand_key: row.brand_key, model_key: row.model_key };
  const next = { attempts: row.attempts + 1, checked_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (!/^[a-z0-9/.-]{5,}$/i.test(row.model) || !/\d/.test(row.model)) {
    fail(await sb.from("model_enrichment").update({ ...next, status: "needs_model", error: "Exact manufacturer model number needed" }).match(key), "needs_model");
    return "needs_model";
  }
  try {
    const source = await findExactModel(row);
    if (!source) {
      fail(await sb.from("model_enrichment").update({ ...next, status: "no_match", error: "No verified exact-model source", next_attempt_at: new Date(Date.now() + 7 * 86400000).toISOString() }).match(key), "no_match");
      return "no_match";
    }
    if (await hasUnitPhotos(sb, row) && !(await existingProfessionalPhotos(sb, row))) {
      for (const [index, imageUrl] of source.images.slice(0, 3).entries()) await savePhoto(sb, row, source.source, imageUrl, index);
    }
    fail(await sb.from("model_enrichment").update({ ...next, status: "matched", description: source.description, specs: source.specs || {}, source_url: source.source, source_title: source.title, error: null }).match(key), "matched");
    return "matched";
  } catch (error) {
    fail(await sb.from("model_enrichment").update({ ...next, status: "pending", error: String(error).slice(0, 300), next_attempt_at: new Date(Date.now() + 3600000).toISOString() }).match(key), "retry");
    return "retry";
  }
}

export default async function handler() {
  const sb = serviceClient();
  const rows = fail(await sb.from("model_enrichment").select("brand_key,model_key,brand,model,status,attempts").in("status", ["pending", "no_match"]).lte("next_attempt_at", new Date().toISOString()).order("created_at").limit(3), "queue");
  const results = [];
  for (const row of rows) results.push({ model: row.model, status: await processRow(sb, row) });
  return new Response(JSON.stringify({ results }), { headers: { "content-type": "application/json" } });
}

export const config = { schedule: "*/5 * * * *" };
