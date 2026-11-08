import { serviceClient } from "../server.mjs";
import { openAdapter } from "./adapters/index.mjs";
import { normalizeTitle } from "./types.mjs";

/**
 * Resumable US-warehouse catalog import in small chunks.
 * Designed for GitHub Actions (or a short Netlify kick) — not one giant Netlify function.
 * Default: ~20 list pages per invocation (~1000 items, ~1000 points) then stop.
 */
export async function importCatalogChunk(storeId, supplier = "cj", opts = {}) {
  const maxPages = Math.min(40, Math.max(1, Number(opts.maxPages) || 20));
  const pageSize = Math.min(100, Math.max(10, Number(opts.pageSize) || 50));
  const sb = serviceClient();

  let run = opts.runId
    ? (await sb.from("supplier_catalog_runs").select("*").eq("id", opts.runId).maybeSingle()).data
    : null;

  if (!run) {
    const latest = await sb
      .from("supplier_catalog_runs")
      .select("*")
      .eq("store_id", storeId)
      .eq("supplier", supplier)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    run = latest.data;
  }

  if (!run || run.status === "done" || run.status === "idle" || run.status === "error") {
    const inserted = await sb
      .from("supplier_catalog_runs")
      .insert({
        store_id: storeId,
        supplier,
        status: "running",
        cursor_page: run && run.status === "done" ? 1 : (run?.cursor_page || 1),
        imported_count: run && run.status === "done" ? 0 : (run?.imported_count || 0),
        matched_us_count: run && run.status === "done" ? 0 : (run?.matched_us_count || 0),
        points_spent: 0,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("*")
      .single();
    if (inserted.error) throw inserted.error;
    run = inserted.data;
  } else if (run.status === "paused") {
    await sb.from("supplier_catalog_runs").update({ status: "running", updated_at: new Date().toISOString() }).eq("id", run.id);
  }

  const { adapter, ctx } = await openAdapter(storeId, supplier);
  if (!adapter.enabled) {
    await sb
      .from("supplier_catalog_runs")
      .update({ status: "error", last_error: "adapter_disabled", updated_at: new Date().toISOString() })
      .eq("id", run.id);
    return { ok: false, error: "adapter_disabled", run };
  }

  let page = Math.max(1, Number(run.cursor_page) || 1);
  let imported = Number(run.imported_count) || 0;
  let matchedUs = Number(run.matched_us_count) || 0;
  let points = Number(run.points_spent) || 0;
  let stopped = null;

  for (let i = 0; i < maxPages; i++) {
    let result;
    try {
      result = await adapter.listCatalog(ctx, { page, size: pageSize, usOnly: true });
    } catch (err) {
      await sb
        .from("supplier_catalog_runs")
        .update({
          status: "error",
          last_error: String(err.message || err).slice(0, 500),
          cursor_page: page,
          imported_count: imported,
          matched_us_count: matchedUs,
          points_spent: points,
          updated_at: new Date().toISOString(),
        })
        .eq("id", run.id);
      return { ok: false, error: err.message, runId: run.id, page, imported };
    }

    if (result.stopped) {
      stopped = result.stopped;
      break;
    }

    points += Number(result.pointsSpent) || 0;
    for (const item of result.items || []) {
      const row = toRow(storeId, supplier, item);
      const { error } = await sb.from("supplier_catalog_items").upsert(row, {
        onConflict: "store_id,supplier,supplier_product_id,variant_key",
      });
      if (error) {
        // Fallback if PostgREST can't target the expression unique index name.
        const existingQ = sb
          .from("supplier_catalog_items")
          .select("id")
          .eq("store_id", storeId)
          .eq("supplier", supplier)
          .eq("supplier_product_id", row.supplier_product_id);
        const existing = row.supplier_variant_id
          ? await existingQ.eq("supplier_variant_id", row.supplier_variant_id).maybeSingle()
          : await existingQ.is("supplier_variant_id", null).maybeSingle();
        if (existing.data?.id) {
          await sb.from("supplier_catalog_items").update({ ...row, updated_at: new Date().toISOString() }).eq("id", existing.data.id);
        } else {
          await sb.from("supplier_catalog_items").insert(row);
        }
      }
      imported += 1;
      if (row.ships_from_us) matchedUs += 1;
    }

    await preferCheapest(storeId, result.items || []);

    if (!result.hasMore) {
      await sb
        .from("supplier_catalog_runs")
        .update({
          status: "done",
          cursor_page: page,
          imported_count: imported,
          matched_us_count: matchedUs,
          points_spent: points,
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_error: null,
        })
        .eq("id", run.id);
      // Persist points on credential row
      if (ctx.queue?.pointsRemaining != null) {
        await ctx.saveTokens({ pointsRemaining: ctx.queue.pointsRemaining });
      }
      return { ok: true, done: true, runId: run.id, imported, matchedUs, points, page };
    }
    page += 1;
  }

  await sb
    .from("supplier_catalog_runs")
    .update({
      status: stopped === "points_budget" ? "paused" : "running",
      cursor_page: page,
      imported_count: imported,
      matched_us_count: matchedUs,
      points_spent: points,
      last_error: stopped || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", run.id);

  if (ctx.queue?.pointsRemaining != null) {
    await ctx.saveTokens({ pointsRemaining: ctx.queue.pointsRemaining });
  }

  return {
    ok: true,
    done: false,
    paused: stopped === "points_budget",
    runId: run.id,
    imported,
    matchedUs,
    points,
    nextPage: page,
  };
}

function toRow(storeId, supplier, item) {
  return {
    store_id: storeId,
    supplier,
    supplier_product_id: item.supplierProductId,
    supplier_variant_id: item.supplierVariantId || null,
    title: item.title,
    normalized_title: normalizeTitle(item.title),
    brand: item.brand || null,
    category: item.category || null,
    upc: item.upc || null,
    image_url: item.imageUrl || null,
    cost_cents: item.costCents || 0,
    shipping_cents: item.shippingCents || 0,
    warehouse_id: item.warehouseId || null,
    warehouse_country: item.warehouseCountry || null,
    warehouse_city: item.warehouseCity || null,
    warehouse_region: item.warehouseRegion || null,
    warehouse_postal: item.warehousePostal || null,
    ships_from_us: Boolean(item.shipsFromUs),
    processing_days: item.processingDays ?? null,
    stock_qty: item.stockQty || 0,
    weight_oz: item.weightOz ?? null,
    raw: item.raw || {},
    updated_at: new Date().toISOString(),
  };
}

/** Simple cross-supplier preference: cheapest landed US option wins. */
async function preferCheapest(storeId, items) {
  const sb = serviceClient();
  for (const item of items) {
    const upc = item.upc || null;
    const norm = normalizeTitle(item.title);
    if (!upc && !norm) continue;
    let q = sb
      .from("supplier_catalog_items")
      .select("id, landed_cents, ships_from_us")
      .eq("store_id", storeId)
      .eq("ships_from_us", true)
      .order("landed_cents", { ascending: true });
    if (upc) q = q.eq("upc", upc);
    else q = q.eq("normalized_title", norm);
    const { data } = await q.limit(10);
    if (!data?.length) continue;
    const best = data[0];
    await sb.from("supplier_catalog_items").update({ preferred: false }).in(
      "id",
      data.map((r) => r.id),
    );
    await sb.from("supplier_catalog_items").update({ preferred: true }).eq("id", best.id);
  }
}
