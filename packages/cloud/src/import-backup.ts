import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertRestorable, type Snapshot } from "@floor/store";
import { storagePathForPhoto } from "./sku.ts";

export type ImportResult = {
  storeId: string;
  skuLedger: number;
  units: number;
  sales: number;
  events: number;
  photos: number;
  photosUploaded: number;
  photosMissing: number;
  photosVerified: number;
  settings: number;
};

function text(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length ? s : null;
}

function intish(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function stamp(v: unknown): string {
  if (typeof v === "string" && v) return v;
  return new Date().toISOString();
}

export function createServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE in the environment.");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function requiredStoreId(): string {
  const id = process.env.STORE_ID?.trim();
  if (!id) {
    throw new Error(
      "Set STORE_ID to the store you created in the app (Sign up → create store). Import will not create a store.",
    );
  }
  return id;
}

/**
 * Load a phone backup into an existing store. Refuses if that store already
 * has units, so a second run cannot double-import.
 */
export async function importPhoneBackup(
  snapshot: unknown,
  client: SupabaseClient = createServiceClient(),
  storeId: string = requiredStoreId(),
): Promise<ImportResult> {
  const snap: Snapshot = assertRestorable(snapshot);
  const tables = snap.tables;

  const store = await client.from("stores").select("id").eq("id", storeId).maybeSingle();
  if (store.error) throw new Error(`stores: ${store.error.message}`);
  if (!store.data) {
    throw new Error(`STORE_ID ${storeId} does not exist. Sign up in the app first, then import.`);
  }

  const existing = await client.from("units").select("id", { count: "exact", head: true }).eq("store_id", storeId);
  if (existing.error) throw new Error(`units count: ${existing.error.message}`);
  if ((existing.count ?? 0) > 0) {
    throw new Error(
      `Store ${storeId} already has ${existing.count} units. Import refused so it cannot run twice.`,
    );
  }

  const result: ImportResult = {
    storeId,
    skuLedger: 0,
    units: 0,
    sales: 0,
    events: 0,
    photos: 0,
    photosUploaded: 0,
    photosMissing: 0,
    photosVerified: 0,
    settings: 0,
  };

  const skipGlobal = new Set(["storeName"]);
  const settingsRows = tables.settings ?? [];
  for (const row of settingsRows) {
    const key = text(row.key);
    if (!key || skipGlobal.has(key)) continue;
    let value: unknown = row.value;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        /* keep the string */
      }
    }
    const { error } = await client.from("store_settings").upsert({ store_id: storeId, key, value });
    if (error) throw new Error(`store_settings ${key}: ${error.message}`);
    result.settings += 1;
  }

  for (const row of tables.sku_ledger ?? []) {
    const sku = text(row.sku);
    if (!sku) continue;
    const { error } = await client.from("sku_ledger").insert({
      store_id: storeId,
      sku,
      issued_at: stamp(row.issued_at),
      label: text(row.label) ?? "",
      fate: text(row.fate) ?? "issued",
    });
    if (error) throw new Error(`sku_ledger ${sku}: ${error.message}`);
    result.skuLedger += 1;
  }

  for (const row of tables.units ?? []) {
    const sku = text(row.sku);
    if (!sku) continue;
    const { error } = await client.from("units").insert({
      store_id: storeId,
      sku,
      brand: text(row.brand) ?? "",
      model: text(row.model) ?? "",
      title: text(row.title) ?? "",
      category: text(row.category),
      condition: text(row.condition),
      test_status: text(row.test_status),
      location: text(row.location),
      mfr_serial: text(row.mfr_serial),
      defect_notes: text(row.defect_notes),
      upc: text(row.upc),
      lot: text(row.lot),
      acquisition_cost_cents: intish(row.acquisition_cost_cents),
      msrp_cents: intish(row.msrp_cents),
      ask_cents: intish(row.ask_cents),
      floor_cents: intish(row.floor_cents),
      state: text(row.state) ?? "available",
      show_on_website: (text(row.state) ?? "available") === "available",
      received_at: stamp(row.received_at),
      updated_at: stamp(row.updated_at),
    });
    if (error) throw new Error(`units ${sku}: ${error.message}`);
    result.units += 1;
  }

  for (const row of tables.sales ?? []) {
    const sku = text(row.sku);
    if (!sku) continue;
    const { error } = await client.from("sales").insert({
      store_id: storeId,
      sku,
      price_cents: intish(row.price_cents) ?? 0,
      tax_cents: 0,
      channel: text(row.channel) ?? "floor",
      payment_method: text(row.payment_method),
      customer_name: text(row.customer_name),
      customer_phone: text(row.customer_phone),
      customer_email: text(row.customer_email),
      note: text(row.note),
      sold_at: stamp(row.sold_at),
      receipt_no: text(row.receipt_no) ?? `IMP-${sku}`,
      voided_at: row.voided_at ? stamp(row.voided_at) : null,
      void_reason: text(row.void_reason),
    });
    if (error) throw new Error(`sales ${sku}: ${error.message}`);
    result.sales += 1;
  }

  for (const row of tables.events ?? []) {
    const { error } = await client.from("events").insert({
      store_id: storeId,
      at: stamp(row.at),
      sku: text(row.sku),
      kind: text(row.kind) ?? "imported",
      field: text(row.field),
      old_value: text(row.old_value),
      new_value: text(row.new_value),
      actor: text(row.actor) ?? "floor",
      note: text(row.note),
    });
    if (error) throw new Error(`events: ${error.message}`);
    result.events += 1;
  }

  const photoData = snap.photoData ?? {};
  for (const row of tables.photos ?? []) {
    const sku = text(row.sku);
    const original = text(row.path);
    if (!sku || !original) continue;
    const path = storagePathForPhoto(storeId, sku, original);
    const b64 = photoData[original] ?? photoData[String(row.path)];
    if (b64) {
      const raw = Buffer.from(b64, "base64");
      const { error: upErr } = await client.storage.from("unit-photos").upload(path, raw, {
        contentType: "image/jpeg",
        upsert: true,
      });
      if (upErr) throw new Error(`photo upload ${path}: ${upErr.message}`);
      result.photosUploaded += 1;
    } else {
      result.photosMissing += 1;
    }
    const { error } = await client.from("photos").insert({
      store_id: storeId,
      sku,
      path,
      original_path: original,
      created_at: stamp(row.created_at),
      is_primary: Number(row.is_primary) === 1 || String(row.is_primary) === "true",
    });
    if (error) throw new Error(`photos ${sku}: ${error.message}`);
    result.photos += 1;
  }

  await client.rpc("move_unit_photos_to_store_layout", { p_store: storeId });
  const verified = await client.rpc("verify_unit_photos", { p_store: storeId });
  if (verified.error) throw new Error(`verify photos: ${verified.error.message}`);
  const rows = (verified.data ?? []) as { path: string; storage_ok: boolean; sku: string }[];
  const missing = rows.filter((r) => !r.storage_ok);
  if (missing.length) {
    throw new Error(
      `Photo verify failed for ${missing.length} file(s): ${missing.slice(0, 5).map((m) => m.path).join(", ")}`,
    );
  }
  result.photosVerified = rows.length;
  return result;
}
