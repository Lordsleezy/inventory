/**
 * Shared Costco/manifest pre-warm runner (Netlify + scripts).
 * Never sets cost/ask. Never publishes channel listings.
 */
import { normalizeGtin } from "./gtin-normalize.mjs";
import { isCostcoInternalCode } from "./gtin.mjs";
import { keepStockPhoto } from "./stock-photo.mjs";
import { lookupUpc } from "./upc-lookup.mjs";
import { saveFloorProduct } from "./floor-products.mjs";
import { resolveCostcoPack } from "./costco-lookup.mjs";
import { suggestCategories, fetchLiveAspects, ebayCategoriesForGtin } from "./ebay-catalog.mjs";
import { serviceClient } from "./server.mjs";

const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

export function linesFromCleanCsv(text) {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  const headers = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  const idx = (name) => headers.indexOf(name.toLowerCase());
  const get = (row, names) => {
    for (const name of names) {
      const i = idx(name);
      if (i >= 0 && String(row[i] || "").trim()) return String(row[i]).trim();
    }
    return "";
  };
  return rows.map((row, i) => {
    const upc = get(row, ["upc"]).replace(/[\s,-]/g, "");
    const qty = Number(get(row, ["qty", "quantity"]) || "1");
    const retail = get(row, ["unit_retail", "unit retail"]).replace(/^\$/, "").replace(/,/g, "");
    return {
      line_number: i + 1,
      upc_normalized: upc,
      item_number: get(row, ["costco_item_number", "item_number", "item #"]),
      description: get(row, ["description", "item description"]),
      brand: get(row, ["brand"]),
      qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
      unit_retail_cents: /^\d+(\.\d{1,2})?$/.test(retail) ? Math.round(Number(retail) * 100) : 0,
      condition: get(row, ["manifest_condition", "condition"]) || "USED_GOOD",
      category: get(row, ["category"]),
      seller_category: get(row, ["seller_category", "seller category"]),
      upc_type: get(row, ["upc_type"]) || (/^4999/.test(upc) ? "costco_internal" : upc.length === 13 ? "ean13" : "upc_a"),
      tcin: get(row, ["costco_item_number", "item_number", "tcin"]),
      lot_id: get(row, ["lot_id", "lot id"]) || null,
    };
  }).filter((l) => /^\d{8,14}$/.test(l.upc_normalized));
}

async function enrichEbay(merged, upc) {
  const out = { categoryId: null, aspects: {}, requiredMissing: [] };
  try {
    if (/^\d{8,14}$/.test(String(upc || ""))) {
      const byGtin = await ebayCategoriesForGtin(upc);
      if (byGtin?.[0]?.categoryId) out.categoryId = String(byGtin[0].categoryId);
    }
  } catch { /* optional */ }
  if (!out.categoryId) {
    try {
      const q = [merged.brand, merged.title || merged.model].filter(Boolean).join(" ").slice(0, 180);
      const suggestions = q ? await suggestCategories(q) : [];
      const id = suggestions?.[0]?.category?.categoryId || suggestions?.[0]?.categoryId;
      if (id) out.categoryId = String(id);
    } catch { /* optional */ }
  }
  if (out.categoryId) {
    try {
      const defs = await fetchLiveAspects(out.categoryId);
      const aspects = { ...(merged.aspects || {}) };
      if (merged.brand && !aspects.Brand) aspects.Brand = merged.brand;
      if (merged.model && !aspects.Model) aspects.Model = merged.model;
      const missing = [];
      for (const def of defs || []) {
        if (!(def.required || def.aspectRequired)) continue;
        const name = def.name || def.localizedAspectName || def.aspectName;
        if (name && !aspects[name]) missing.push(name);
      }
      out.aspects = aspects;
      out.requiredMissing = missing;
    } catch { /* optional */ }
  }
  return out;
}

function packCount(text) {
  const match = String(text || "").match(/\b(\d+)\s*(?:ct|count|pack|pk)\b/i);
  return match ? Number(match[1]) : null;
}

function gapsOf(merged, ebay) {
  const missing = [];
  if (!merged?.title) missing.push("title");
  if (!merged?.brand) missing.push("brand");
  if (!merged?.description && !(merged?.features || []).length) missing.push("description");
  if (!(merged?.images || []).length) missing.push("images");
  if (!ebay?.categoryId) missing.push("ebay_category");
  if ((ebay?.requiredMissing || []).length) missing.push(`aspects:${ebay.requiredMissing.join("|")}`);
  const pkg = merged?.package || {};
  if (pkg.length_in == null || pkg.width_in == null || pkg.height_in == null) missing.push("dims");
  if (pkg.weight_lb == null) missing.push("weight");
  return missing;
}

export async function prewarmManifestLines(storeId, lines, {
  force = false,
  sleepMs = 120,
  dryRun = false,
  onRow = null,
} = {}) {
  const sb = serviceClient();
  const report = {
    total: lines.length,
    amazon: 0,
    upcitemdb: 0,
    costco: 0,
    ebay: 0,
    manifest_only: 0,
    nothing: 0,
    listing_ready: 0,
    missing: [],
    internal4999: [],
    conflicts: [],
    errors: [],
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isInternal = line.upc_type === "costco_internal" || /^4999/.test(line.upc_normalized);
    try {
      const gtin = normalizeGtin(line.upc_normalized);
      if (!gtin.ok) {
        if (isInternal) {
          const costco = await resolveCostcoPack({
            itemNumber: line.item_number || line.tcin,
            brand: line.brand,
            description: line.description,
            title: line.description,
            upc: null,
          });
          const manufacturerUpc = costco.manufacturer_upc && !isCostcoInternalCode(costco.manufacturer_upc) && costco.via === "costco"
            ? costco.manufacturer_upc
            : null;
          report.internal4999.push({
            upc: line.upc_normalized,
            item_number: line.item_number || line.tcin,
            description: line.description,
            brand: line.brand,
            manufacturer_upc: manufacturerUpc,
            candidate: Boolean(manufacturerUpc),
            primary: "costco_item_number",
            title: costco.title || [line.brand, line.description].filter(Boolean).join(" ") || null,
            gaps: manufacturerUpc ? [] : ["candidate_gtin"],
          });
          if (!dryRun && manufacturerUpc) {
            const real = normalizeGtin(manufacturerUpc);
            if (real.ok) {
              await saveFloorProduct(sb, real, {
                title: costco.title || line.description,
                brand: costco.brand || line.brand,
                description: costco.description || line.description,
                images: (costco.images || []).filter((url) => keepStockPhoto(url)),
                aspects: { costco_item_number: line.item_number || line.tcin, candidate_gtin: true },
                package: costco.package || {},
              }, { source: "lookup" });
            }
          }
        } else {
          report.nothing++;
          report.errors.push({ upc: line.upc_normalized, error: gtin.issue });
        }
        continue;
      }
      let result = null;
      let primary = "nothing";
      if (!isInternal) {
        result = await lookupUpc(storeId, line.upc_normalized, {
          force,
          skipEbay: true,
          costcoItemNumber: line.item_number || line.tcin,
          costcoBrand: line.brand,
          costcoDescription: line.description,
        });
        if (result?.amazon?.found && result?.fieldCoverage?.title === "amazon") primary = "amazon";
        else if (result?.upcitemdb?.found) primary = "upcitemdb";
        else if (result?.costco?.found) primary = result.costco.via === "costco" ? "costco" : "ebay";
        else if (result?.merged && !result.merged.not_found) primary = result.fieldCoverage?.title || "lookup";
      }

      let merged = { ...(result?.merged || { not_found: true, package: {}, images: [], aspects: {}, features: [] }) };
      if (!merged.brand && line.brand) merged.brand = line.brand;
      if (!merged.title && line.description) merged.title = [line.brand, line.description].filter(Boolean).join(" ");
      if (!merged.category && (line.seller_category || line.category)) merged.category = line.seller_category || line.category;
      if (!merged.description && line.description) merged.description = line.description;

      let costco = { found: false };
      if (isInternal || !result?.amazon?.found || result?.merged?.not_found || !(merged.images || []).length) {
        costco = await resolveCostcoPack({
          itemNumber: line.item_number || line.tcin,
          brand: line.brand,
          description: line.description,
          title: merged.title,
          upc: line.upc_normalized,
        });
        if (costco.found) {
          if (!merged.title && costco.title) merged.title = costco.title;
          if (!merged.brand && costco.brand) merged.brand = costco.brand;
          if (!merged.model && costco.model) merged.model = costco.model;
          if (!merged.description && costco.description) merged.description = costco.description;
          if (!(merged.images || []).length && costco.images?.length) merged.images = costco.images;
          if (costco.aspects) merged.aspects = { ...costco.aspects, ...(merged.aspects || {}) };
          if (primary === "nothing") primary = costco.via === "costco" ? "costco" : "ebay";
        }
      }

      const manifestPack = packCount(line.description);
      const catalogPack = packCount(merged.title);
      if (manifestPack && catalogPack && manifestPack !== catalogPack) {
        report.conflicts.push({
          upc: line.upc_normalized,
          item_number: line.item_number || line.tcin,
          manifest_pack: manifestPack,
          catalog_pack: catalogPack,
        });
        merged.title = [line.brand, line.description].filter(Boolean).join(" ");
        merged.aspects = { ...(merged.aspects || {}), pack_conflict: true };
      }

      if (primary === "nothing" && (merged.title || merged.brand)) primary = "manifest_only";
      const ebay = await enrichEbay(merged, costco.manufacturer_upc || line.upc_normalized);
      if (ebay.categoryId) {
        merged.aspects = { ...ebay.aspects, ...(merged.aspects || {}) };
        merged.ebay_category_id = ebay.categoryId;
        if (primary === "manifest_only" || primary === "nothing") primary = "ebay";
      }

      const gaps = gapsOf(merged, ebay);
      if (!gaps.length) report.listing_ready++;
      else {
        report.missing.push({
          upc: line.upc_normalized,
          item_number: line.item_number || line.tcin,
          description: line.description,
          missing: gaps,
          primary,
        });
      }

      if (primary === "amazon") report.amazon++;
      else if (primary === "upcitemdb") report.upcitemdb++;
      else if (primary === "costco") report.costco++;
      else if (primary === "ebay") report.ebay++;
      else if (primary === "manifest_only") report.manifest_only++;
      else report.nothing++;

      const manufacturerUpc = costco.manufacturer_upc && !/^4999/.test(costco.manufacturer_upc)
        ? costco.manufacturer_upc
        : null;
      if (isInternal) {
        report.internal4999.push({
          upc: line.upc_normalized,
          item_number: line.item_number || line.tcin,
          description: line.description,
          brand: line.brand,
          manufacturer_upc: manufacturerUpc,
          primary,
          title: merged.title || null,
          gaps,
        });
      }

      merged.images = (merged.images || []).filter((url) => keepStockPhoto({ url, source: "amazon" }) || keepStockPhoto(url));
      if (!dryRun && !isInternal && (merged.title || merged.brand)) {
        const saveSource = primary === "amazon" ? "amazon" : primary === "upcitemdb" ? "upcitemdb" : "lookup";
        if (!isCostcoInternalCode(line.upc_normalized)) {
          await saveFloorProduct(sb, gtin, merged, { source: saveSource });
        }
        if (manufacturerUpc && costco.via === "costco" && manufacturerUpc !== line.upc_normalized && !isCostcoInternalCode(manufacturerUpc)) {
          const real = normalizeGtin(manufacturerUpc);
          if (real.ok) await saveFloorProduct(sb, real, { ...merged, aspects: { ...(merged.aspects || {}), candidate_gtin: true, costco_item_number: line.item_number || line.tcin } }, { source: saveSource });
        }
        const payload = {
          gtin: { gtin14: gtin.gtin14, upcA: gtin.upcA, ean13: gtin.ean13 },
          amazon: result?.amazon || { found: false },
          upcitemdb: result?.upcitemdb || { found: false },
          costco: costco.found ? costco : { found: false },
          ebay_enrichment: ebay,
          merged,
          fieldCoverage: result?.fieldCoverage || {},
          looked_up_at: new Date().toISOString(),
          prewarm: { lot: line.lot_id || null, item_number: line.item_number || line.tcin },
        };
        await sb.from("upc_lookup_cache").upsert({
          gtin14: gtin.gtin14,
          payload,
          amazon: payload.amazon,
          upcitemdb: payload.upcitemdb,
          ebay: null,
          looked_up_at: payload.looked_up_at,
        }, { onConflict: "gtin14" });
      }

      if (onRow) {
        onRow({
          i: i + 1,
          upc: line.upc_normalized,
          primary,
          title: merged.title || null,
          gaps,
          manufacturer_upc: manufacturerUpc,
        });
      }
    } catch (e) {
      report.errors.push({ upc: line.upc_normalized, error: String(e?.message || e).slice(0, 300) });
    }
    if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
  }
  return report;
}

export async function prewarmFromCsvText(storeId, csvText, opts = {}) {
  return prewarmManifestLines(storeId, linesFromCleanCsv(csvText), opts);
}
