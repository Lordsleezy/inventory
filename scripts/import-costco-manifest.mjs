#!/usr/bin/env node
/**
 * Import TRA-7096264 clean CSV into store_manifests + manifest_lines (service role).
 * Uses columns that already exist on live; item # goes into tcin until migration lands.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { parseManifestLines } from "../apps/admin/src/manifestLines.ts";

const csvPath = path.resolve(
  process.argv[2] || "data/manifests/TRA-7096264_clean_for_floor.csv",
);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
});

const lines = parseManifestLines(fs.readFileSync(csvPath, "utf8"));
const units = lines.reduce((s, l) => s + l.qty, 0);
const { data: storeRow, error: storeErr } = await sb.from("store_manifests").select("store_id").limit(1).maybeSingle();
if (storeErr || !storeRow?.store_id) throw new Error(storeErr?.message || "store_missing");
const storeId = storeRow.store_id;

const { data: existing } = await sb
  .from("store_manifests")
  .select("id,name,item_count")
  .eq("store_id", storeId)
  .ilike("name", "%TRA-7096264%")
  .maybeSingle();

let manifestId = existing?.id;
if (manifestId) {
  const { count } = await sb
    .from("manifest_lines")
    .select("*", { count: "exact", head: true })
    .eq("manifest_id", manifestId);
  if (count > 0) {
    console.log(JSON.stringify({ event: "manifest_already_imported", manifestId, lines: count }));
    process.exit(0);
  }
} else {
  manifestId = crypto.randomUUID();
  const storagePath = `${storeId}/manifests/${manifestId}/TRA-7096264_clean_for_floor.csv`;
  const body = fs.readFileSync(csvPath);
  const { error: upErr } = await sb.storage.from("floor-manifests").upload(storagePath, body, {
    contentType: "text/csv",
    upsert: true,
  });
  if (upErr) console.log(JSON.stringify({ event: "storage_upload_warn", error: upErr.message }));

  const { error: manErr } = await sb.from("store_manifests").insert({
    id: manifestId,
    store_id: storeId,
    name: "Costco B-Stock TRA-7096264 (Oral care / hardware / massage)",
    source: "bstock",
    manifest_on: "2026-11-11",
    item_count: units,
    count_source: "spreadsheet",
    storage_path: storagePath,
    content_type: "text/csv",
    file_size: body.length,
  });
  if (manErr) throw new Error(manErr.message);
}

const chunk = 100;
for (let i = 0; i < lines.length; i += chunk) {
  const slice = lines.slice(i, i + chunk).map((l) => ({
    manifest_id: manifestId,
    line_number: l.line_number,
    upc_raw: l.upc_normalized, // already cleaned; avoid trailing commas in storage
    tcin: l.item_number || l.tcin || "",
    description: l.description || "",
    brand: l.brand || "",
    qty: l.qty,
    unit_retail_cents: l.unit_retail_cents,
    condition: l.condition,
    pallet_id: l.pallet_id || "",
    lot_id: l.lot_id || "TRA-7096264",
  }));
  const { error } = await sb.from("manifest_lines").insert(slice);
  if (error) throw new Error(`lines ${i}: ${error.message}`);
}

console.log(JSON.stringify({
  event: "manifest_imported",
  manifestId,
  lines: lines.length,
  units,
}));
