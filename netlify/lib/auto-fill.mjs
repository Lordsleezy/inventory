/**
 * Auto-pick the eBay category and auto-generate the description for a unit. No AI.
 * Category: what Floor already knows (live listing, UPC memory, Catalog) via autofillUnitSpecifics, else eBay's top suggested
 * category for the title (the one item edit shows), saved with source "auto_suggested". Specifics are then pre-filled (PR 161).
 * Description: the same text the "Use generated description" checkbox makes; only saved where the description is blank.
 * Never checks a channel, never lists, never changes a category or description that is already set.
 */
import { autofillUnitSpecifics } from "./ebay-specifics.mjs";

export const AUTO_SOURCE = "auto_suggested";
const text = (v) => String(v ?? "").trim();

/** Same text as item edit's "Use generated description". */
export function makeDescription(item = {}, sku = "") {
  const identity = [item.brand, item.model].map(text).filter(Boolean).join(" ");
  const name = text(item.title) || identity || `Item ${sku}`;
  const condition = text(item.condition) ? `Condition: ${text(item.condition)}.` : "";
  const notes = text(item.defect_notes) ? `Notes: ${text(item.defect_notes)}.` : "";
  return [name.endsWith(".") ? name : `${name}.`, condition, notes].filter(Boolean).join("\n\n");
}

export const hasName = (unit) => Boolean(text(unit.title) || [unit.brand, unit.model].map(text).some(Boolean));

/**
 * deps: loadUnit(storeId, sku) -> { title, brand, model, condition, defect_notes, listing_body, tried_title } | null
 *       suggest(unit) -> leaf category id or null (first active eBay leaf for the title; throws if eBay is unreachable)
 *       prepareCategory(categoryId) -> ensures aspect fields are cached
 *       saveCategory(storeId, sku, categoryId) -> upsert source auto_suggested (only called when no category exists)
 *       specifics(storeId, sku) -> autofillUnitSpecifics result
 *       saveDescription(storeId, sku, text) -> true when saved (only where still blank)
 *       markTried(storeId, sku, title)
 */
export async function autoFillUnit(deps, storeId, sku, { write = true } = {}) {
  const unit = await deps.loadUnit(storeId, sku);
  if (!unit) return { sku, category: "unknown_sku", description: "unknown_sku" };
  const out = { sku, category: "existing", description: "existing", specificsMissing: [] };

  let spec = await deps.specifics(storeId, sku, { write });
  let categoryId = spec.categoryId || null;
  const hadCategory = Boolean(unit.category_id);
  if (spec.skipped === "ebay_disabled") return { ...out, category: "ebay_disabled", description: await describe(deps, storeId, sku, unit, write) };
  if (!hadCategory && spec.categorySource) out.category = `set_${spec.categorySource}`;
  if (!categoryId && !hadCategory) {
    out.category = "none";
    if (text(unit.title) && text(unit.tried_title) !== text(unit.title)) {
      let suggested = null; let failed = false;
      try { suggested = await deps.suggest(unit); } catch { failed = true; }
      if (suggested) {
        await deps.prepareCategory(suggested);
        if (write) {
          await deps.saveCategory(storeId, sku, suggested);
          spec = await deps.specifics(storeId, sku, { write });
        }
        categoryId = suggested; out.category = "set_auto_suggested";
      } else {
        out.category = failed ? "suggestion_error" : "no_suggestion";
        if (write && !failed) await deps.markTried(storeId, sku, text(unit.title));
      }
    } else if (!text(unit.title)) out.category = "no_title";
    else out.category = "no_suggestion";
  }
  if (categoryId) out.specificsMissing = spec.missing || [];

  out.description = await describe(deps, storeId, sku, unit, write);
  return out;
}

async function describe(deps, storeId, sku, unit, write) {
  if (text(unit.listing_body)) return "existing";
  if (!hasName(unit)) return "no_name";
  if (write && !(await deps.saveDescription(storeId, sku, makeDescription(unit, sku)))) return "existing";
  return "set";
}

/** Supabase-backed deps (service role). */
export function supabaseAutoFillDeps(sb, { suggestCategories, specificsDeps, ebayAspectFields }) {
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  return {
    loadUnit: async (storeId, sku) => {
      const u = must(await sb.from("units").select("title,brand,model,condition,defect_notes,listing_body,listing_specs")
        .eq("store_id", storeId).eq("sku", sku).maybeSingle());
      if (!u) return null;
      const row = must(await sb.from("unit_channel_categories").select("category_id").eq("store_id", storeId).eq("sku", sku).eq("channel", "ebay").maybeSingle());
      return { ...u, category_id: row?.category_id || null, tried_title: u.listing_specs?.auto_category_tried || "" };
    },
    suggest: async (unit) => {
      for (const s of await suggestCategories(text(unit.title))) {
        const t = must(await sb.from("channel_taxonomy").select("category_id").eq("channel", "ebay").eq("category_id", s.categoryId)
          .eq("active", true).eq("leaf", true).maybeSingle());
        if (t) return t.category_id;
      }
      return null;
    },
    prepareCategory: (categoryId) => ebayAspectFields(categoryId),
    saveCategory: async (storeId, sku, categoryId) => {
      const row = must(await sb.from("unit_channel_categories").select("attributes").eq("store_id", storeId).eq("sku", sku).eq("channel", "ebay").maybeSingle());
      await specificsDeps.saveEbayRow(storeId, sku, { category_id: categoryId, source: AUTO_SOURCE, attributes: row?.attributes || {} });
    },
    specifics: (storeId, sku, opts) => autofillUnitSpecifics(specificsDeps, storeId, sku, opts),
    saveDescription: async (storeId, sku, body) => {
      const cur = must(await sb.from("units").select("listing_body").eq("store_id", storeId).eq("sku", sku).maybeSingle());
      if (text(cur?.listing_body)) return false;
      let q = sb.from("units").update({ listing_body: body }).eq("store_id", storeId).eq("sku", sku);
      q = cur?.listing_body == null ? q.is("listing_body", null) : q.eq("listing_body", cur.listing_body);
      return (must(await q.select("sku")) || []).length > 0;
    },
    markTried: async (storeId, sku, title) => { must(await sb.rpc("floor_auto_fill_mark", { p_store: storeId, p_sku: sku, p_title: title })); },
  };
}

/** Units that still need an auto category (new title, no category) or a description. */
export async function autoFillCandidates(sb, storeId, { sku = null, limit = 8 } = {}) {
  const { data, error } = await sb.rpc("floor_auto_fill_snapshot", { p_store: storeId, p_sku: sku });
  if (error) throw new Error(error.message);
  const rows = (data || []).filter((r) => r.eligible && (
    (!r.has_category && text(r.title) && text(r.tried_title) !== text(r.title)) || (!r.has_description && r.has_name)));
  return rows.sort(() => Math.random() - 0.5).slice(0, limit).map((r) => r.sku);
}
