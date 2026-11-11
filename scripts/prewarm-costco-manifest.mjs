#!/usr/bin/env node
/**
 * Pre-warm Floor's UPC product DB from a Costco B-Stock manifest CSV.
 *
 * Lookup chain per UPC: Amazon SP-API → UPCitemdb → Costco.com (best effort) /
 * eBay Browse identity fallback → eBay Taxonomy category + required aspects.
 *
 * Writes floor_products + upc_lookup_cache. Never sets cost or sell price.
 * Never pushes channel listings.
 *
 * Usage:
 *   node --experimental-strip-types scripts/prewarm-costco-manifest.mjs \
 *     [--csv data/manifests/TRA-7096264_clean_for_floor.csv] \
 *     [--limit N] [--offset N] [--force] [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { parseManifestLines } from "../apps/admin/src/manifestLines.ts";
import { normalizeGtin } from "../netlify/lib/gtin-normalize.mjs";
import { lookupUpc } from "../netlify/lib/upc-lookup.mjs";
import { saveFloorProduct } from "../netlify/lib/floor-products.mjs";
import { resolveCostcoPack } from "../netlify/lib/costco-lookup.mjs";
import { suggestCategories, fetchLiveAspects, ebayCategoriesForGtin } from "../netlify/lib/ebay-catalog.mjs";

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  return args[i + 1] ?? true;
}

const csvPath = path.resolve(
  flag("--csv", "data/manifests/TRA-7096264_clean_for_floor.csv"),
);
const limit = Number(flag("--limit", "0")) || 0;
const offset = Number(flag("--offset", "0")) || 0;
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const sleepMs = Number(flag("--sleep", "150")) || 150;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function upcTypeOf(digits) {
  if (/^4999/.test(digits)) return "costco_internal";
  if (digits.length === 13) return "ean13";
  if (digits.length === 12) return "upc_a";
  return "other";
}

function listingReady(merged, ebay) {
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

async function enrichEbay(merged, upc) {
  const out = { categoryId: null, categoryPath: null, aspects: {}, requiredMissing: [], via: null };
  try {
    if (/^\d{8,14}$/.test(String(upc || ""))) {
      const byGtin = await ebayCategoriesForGtin(upc);
      if (byGtin?.[0]?.categoryId) {
        out.categoryId = String(byGtin[0].categoryId);
        out.via = "ebay_browse_gtin";
      }
    }
  } catch {
    /* browse optional */
  }
  if (!out.categoryId) {
    try {
      const q = [merged.brand, merged.title || merged.model].filter(Boolean).join(" ").slice(0, 180);
      const suggestions = q ? await suggestCategories(q) : [];
      const top = suggestions?.[0];
      const id = top?.category?.categoryId || top?.categoryId;
      if (id) {
        out.categoryId = String(id);
        out.categoryPath = top?.categoryTreeNodeAncestors
          ? [...(top.categoryTreeNodeAncestors || []).map((a) => a.categoryName), top.category?.categoryName]
              .filter(Boolean)
              .join(" > ")
          : top?.category?.categoryName || null;
        out.via = "ebay_taxonomy";
      }
    } catch {
      /* taxonomy optional */
    }
  }
  if (out.categoryId) {
    try {
      const defs = await fetchLiveAspects(out.categoryId);
      const required = (defs || []).filter((d) => d.required || d.aspectRequired);
      const aspects = { ...(merged.aspects || {}) };
      if (merged.brand && !aspects.Brand) aspects.Brand = merged.brand;
      if (merged.model && !aspects.Model && !aspects["Model Number"]) aspects.Model = merged.model;
      const missing = [];
      for (const def of required) {
        const name = def.name || def.localizedAspectName || def.aspectName;
        if (!name) continue;
        if (!aspects[name]) missing.push(name);
      }
      out.aspects = aspects;
      out.requiredMissing = missing;
    } catch {
      /* aspects optional */
    }
  }
  return out;
}

function mergeCostco(merged, costco, manifest) {
  const next = { ...merged, package: { ...(merged.package || {}) }, aspects: { ...(merged.aspects || {}) } };
  const coverage = {};
  if (!next.title && (costco.title || manifest.description)) {
    next.title = costco.title || [manifest.brand, manifest.description].filter(Boolean).join(" ");
    coverage.title = costco.title ? costco.via || "costco" : "manifest";
  }
  if (!next.brand && (costco.brand || manifest.brand)) {
    next.brand = costco.brand || manifest.brand;
    coverage.brand = costco.brand ? costco.via || "costco" : "manifest";
  }
  if (!next.model && costco.model) {
    next.model = costco.model;
    coverage.model = costco.via || "costco";
  }
  if (!next.description && (costco.description || manifest.description)) {
    next.description = costco.description || manifest.description;
    coverage.description = costco.description ? costco.via || "costco" : "manifest";
  }
  if (!(next.images || []).length && (costco.images || []).length) {
    next.images = costco.images;
    coverage.images = costco.via || "costco";
  }
  if (costco.aspects && typeof costco.aspects === "object") {
    next.aspects = { ...costco.aspects, ...next.aspects };
  }
  if (costco.ebay_category_id) next.ebay_category_id = costco.ebay_category_id;
  // Manifest category is identity only — store as Floor category hint, not eBay leaf.
  if (!next.category && (manifest.seller_category || manifest.category)) {
    next.category = manifest.seller_category || manifest.category;
    coverage.category = "manifest";
  }
  next.not_found = !(next.title || next.brand);
  return { merged: next, coverage };
}

async function main() {
  if (!fs.existsSync(csvPath)) {
    console.error("csv_missing", csvPath);
    process.exit(1);
  }
  const { data: storeRow } = await sb.from("store_manifests").select("store_id").limit(1).maybeSingle();
  const storeId = storeRow?.store_id;
  if (!storeId) {
    console.error("store_missing");
    process.exit(1);
  }

  let lines = parseManifestLines(fs.readFileSync(csvPath, "utf8"));
  // Ensure upc_type is set for Costco internal stickers.
  lines = lines.map((l) => ({
    ...l,
    upc_type: l.upc_type || upcTypeOf(l.upc_normalized),
  }));
  if (offset) lines = lines.slice(offset);
  if (limit > 0) lines = lines.slice(0, limit);

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
    errors: [],
    started_at: new Date().toISOString(),
  };

  console.log(JSON.stringify({ event: "prewarm_start", storeId, csvPath, count: lines.length, force, dryRun }));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const row = {
      i: offset + i + 1,
      upc: line.upc_normalized,
      item_number: line.item_number || line.tcin,
      description: line.description,
      brand: line.brand,
      upc_type: line.upc_type,
    };
    try {
      const gtin = normalizeGtin(line.upc_normalized);
      if (!gtin.ok) {
        report.nothing++;
        report.errors.push({ ...row, error: gtin.issue });
        continue;
      }

      let result = null;
      let primary = "nothing";
      // Costco-internal 4999 codes will miss catalogs; skip Amazon noise when clearly internal.
      const isInternal = line.upc_type === "costco_internal" || /^4999/.test(line.upc_normalized);
      if (!isInternal) {
        result = await lookupUpc(storeId, line.upc_normalized, {
          force,
          // Sold-comps Insights API is locked for this app; Browse/Taxonomy run separately.
          skipEbay: true,
          compareUpcitemdb: false,
          costcoItemNumber: line.item_number || line.tcin,
          costcoBrand: line.brand,
          costcoDescription: line.description,
        });
        if (result?.amazon?.found && result?.fieldCoverage?.title === "amazon") primary = "amazon";
        else if (result?.upcitemdb?.found) primary = "upcitemdb";
        else if (result?.fieldCoverage?.title === "amazon") primary = "amazon";
        else if (result?.merged && !result.merged.not_found) {
          primary = result.fieldCoverage?.title || "amazon";
        }
      }

      let merged = {
        ...(result?.merged || { not_found: true, package: {}, images: [], aspects: {}, features: [] }),
      };
      // Always trust manifest identity for brand/title gaps (never price/cost).
      if (!merged.brand && line.brand) merged.brand = line.brand;
      if (!merged.title && line.description) {
        merged.title = [line.brand, line.description].filter(Boolean).join(" ");
      }
      if (!merged.category && (line.seller_category || line.category)) {
        merged.category = line.seller_category || line.category;
      }
      if (!merged.description && line.description) merged.description = line.description;

      let costco = { found: false };
      const needsCostco =
        isInternal ||
        !result?.amazon?.found ||
        result?.merged?.not_found ||
        !(merged.images || []).length ||
        !merged.title;
      if (needsCostco) {
        costco = await resolveCostcoPack({
          itemNumber: line.item_number || line.tcin,
          brand: line.brand,
          description: line.description,
          title: merged.title,
          upc: line.upc_normalized,
        });
        const folded = mergeCostco(merged, costco, line);
        merged = folded.merged;
        if (costco.found && costco.via === "costco") primary = primary === "nothing" ? "costco" : primary;
        if (costco.found && costco.via === "ebay" && (primary === "nothing" || isInternal)) primary = "ebay";
      }

      if (primary === "nothing" && (merged.title || merged.brand)) primary = "manifest_only";

      const ebay = await enrichEbay(merged, costco.manufacturer_upc || line.upc_normalized);
      if (ebay.categoryId) {
        merged.aspects = { ...ebay.aspects, ...(merged.aspects || {}) };
        merged.ebay_category_id = ebay.categoryId;
        if (ebay.categoryPath) merged.ebay_category_path = ebay.categoryPath;
        if (primary === "manifest_only" || primary === "nothing") primary = "ebay";
      }

      const gaps = listingReady(merged, ebay);
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

      if (!dryRun && (merged.title || merged.brand)) {
        // Live schema only allows amazon|upcitemdb|photo|manual|lookup until migration ships.
        const saveSource =
          primary === "amazon" ? "amazon" : primary === "upcitemdb" ? "upcitemdb" : "lookup";
        const saveGtin = gtin;
        await saveFloorProduct(sb, saveGtin, merged, { source: saveSource });
        // Dual-key Costco stickers: also cache under manufacturer UPC when discovered.
        if (manufacturerUpc && manufacturerUpc !== line.upc_normalized) {
          const real = normalizeGtin(manufacturerUpc);
          if (real.ok) await saveFloorProduct(sb, real, merged, { source: saveSource });
        }
        // Refresh cache payload so scans hit instantly with field coverage.
        const gtin14 = gtin.gtin14;
        const payload = {
          gtin: { gtin14: gtin.gtin14, upcA: gtin.upcA, ean13: gtin.ean13 },
          cached: false,
          amazon: result?.amazon || { found: false },
          upcitemdb: result?.upcitemdb || { found: false },
          ebay: result?.ebay || null,
          costco: costco.found ? costco : { found: false, raw_error: costco.raw_error || null },
          ebay_enrichment: ebay,
          merged,
          fieldCoverage: {
            ...(result?.fieldCoverage || {}),
            title: result?.fieldCoverage?.title || (merged.title ? primary : null),
            brand: result?.fieldCoverage?.brand || (merged.brand ? primary : null),
            manifest: "identity",
          },
          looked_up_at: new Date().toISOString(),
          prewarm: { lot: line.lot_id || "TRA-7096264", item_number: line.item_number || line.tcin },
        };
        await sb.from("upc_lookup_cache").upsert(
          {
            gtin14,
            payload,
            amazon: payload.amazon,
            upcitemdb: payload.upcitemdb,
            ebay: payload.ebay,
            looked_up_at: payload.looked_up_at,
          },
          { onConflict: "gtin14" },
        );
        if (manufacturerUpc) {
          const real = normalizeGtin(manufacturerUpc);
          if (real.ok) {
            await sb.from("upc_lookup_cache").upsert(
              {
                gtin14: real.gtin14,
                payload: { ...payload, gtin: { gtin14: real.gtin14, upcA: real.upcA, ean13: real.ean13 } },
                amazon: payload.amazon,
                upcitemdb: payload.upcitemdb,
                ebay: payload.ebay,
                looked_up_at: payload.looked_up_at,
              },
              { onConflict: "gtin14" },
            );
          }
        }
      }

      console.log(JSON.stringify({
        event: "prewarm_row",
        ...row,
        primary,
        title: merged.title || null,
        gaps,
        manufacturer_upc: manufacturerUpc,
        amazon: Boolean(result?.amazon?.found),
        upcitemdb: Boolean(result?.upcitemdb?.found),
        costco: Boolean(costco.found),
      }));
    } catch (e) {
      report.errors.push({ ...row, error: String(e?.message || e).slice(0, 300) });
      console.log(JSON.stringify({ event: "prewarm_error", ...row, error: String(e?.message || e).slice(0, 300) }));
    }
    if (sleepMs) await sleep(sleepMs);
  }

  report.finished_at = new Date().toISOString();
  const outDir = path.resolve("reports");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `prewarm-TRA-7096264-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    event: "prewarm_done",
    report: {
      total: report.total,
      amazon: report.amazon,
      upcitemdb: report.upcitemdb,
      costco: report.costco,
      ebay: report.ebay,
      manifest_only: report.manifest_only,
      nothing: report.nothing,
      listing_ready: report.listing_ready,
      missing_count: report.missing.length,
      internal4999: report.internal4999.length,
      errors: report.errors.length,
    },
    outFile,
  }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
