/**
 * Anon may signed-URL a for-sale unit photo and is denied a sold unit's photo.
 * Website uses createSignedUrl, not download().
 *
 *   set SUPABASE_URL=...
 *   set SUPABASE_ANON_KEY=...
 *   set SUPABASE_SERVICE_ROLE=...
 *   node --experimental-strip-types scripts/test-photo-rls.mjs
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE;

if (!url || !anonKey || !serviceKey) {
  console.error("Set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE.");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anon = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** 1×1 JPEG so Storage accepts the object. */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAAD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAG/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPwB//9k=",
  "base64",
);

function pathsOf(row) {
  const raw = row?.photo_paths ?? row?.primary_photo_path;
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === "string" && raw.startsWith("[")) {
    try {
      return JSON.parse(raw).filter(Boolean);
    } catch {
      return [];
    }
  }
  return raw ? [raw] : [];
}

async function firstStoreId() {
  const { data, error } = await admin.from("stores").select("id").limit(1);
  if (error) throw new Error(`stores: ${error.message}`);
  const id = data?.[0]?.id;
  if (!id) throw new Error("No store. Sign up in the app first, then import.");
  return id;
}

async function findSoldPhoto() {
  const { data: soldRows, error } = await admin.from("sales").select("sku, store_id").is("voided_at", null).limit(50);
  if (error) throw new Error(`sales: ${error.message}`);
  for (const sale of soldRows ?? []) {
    const { data: photos } = await admin.from("photos").select("path").eq("sku", sale.sku).eq("store_id", sale.store_id).limit(1);
    if (photos?.[0]?.path) return { sku: sale.sku, path: photos[0].path, disposable: false };
  }
  return null;
}

async function unusedTestSku(storeId) {
  for (let n = 99990; n <= 99999; n += 1) {
    const sku = String(n);
    const { data } = await admin.from("sku_ledger").select("sku").eq("sku", sku).eq("store_id", storeId).maybeSingle();
    if (!data) return sku;
  }
  throw new Error("No free throwaway SKU in 99990–99999.");
}

async function createThrowawaySoldPhoto() {
  const storeId = await firstStoreId();
  const sku = await unusedTestSku(storeId);
  const path = `${storeId}/${sku}/rls-test.jpg`;
  const now = new Date().toISOString();

  const ledger = await admin.from("sku_ledger").insert({
    store_id: storeId,
    sku,
    issued_at: now,
    label: "photo-rls throwaway",
    fate: "issued",
  });
  if (ledger.error) throw new Error(`sku_ledger: ${ledger.error.message}`);

  const unit = await admin.from("units").insert({
    store_id: storeId,
    sku,
    title: "photo-rls throwaway",
    state: "available",
    show_on_website: true,
    received_at: now,
    updated_at: now,
  });
  if (unit.error) throw new Error(`units: ${unit.error.message}`);

  const up = await admin.storage.from("unit-photos").upload(path, TINY_JPEG, {
    contentType: "image/jpeg",
    upsert: true,
  });
  if (up.error) throw new Error(`upload: ${up.error.message}`);

  const photo = await admin.from("photos").insert({
    store_id: storeId,
    sku,
    path,
    original_path: path,
    created_at: now,
    is_primary: true,
  });
  if (photo.error) throw new Error(`photos: ${photo.error.message}`);

  const sold = await admin.rpc("finalize_sale", {
    p_sku: sku,
    p_channel: "floor",
    p_price_cents: 1,
    p_note: "photo-rls throwaway",
  });
  if (sold.error) throw new Error(`finalize_sale: ${sold.error.message}`);

  const soldRow = Array.isArray(sold.data) ? sold.data[0] : sold.data;
  return { sku, path, disposable: true, saleId: soldRow?.id, storeId };
}

async function cleanupThrowaway(sku, path, saleId, storeId) {
  if (saleId) {
    const voided = await admin.rpc("void_sale", {
      p_sale_id: saleId,
      p_reason: "photo-rls cleanup",
    });
    if (voided.error) console.error(`void_sale: ${voided.error.message}`);
  }
  await admin.from("photos").delete().eq("sku", sku).eq("store_id", storeId);
  await admin.storage.from("unit-photos").remove([path]);
  await admin.from("events").delete().eq("sku", sku).eq("store_id", storeId);
  await admin.from("delist_tasks").delete().eq("sku", sku).eq("store_id", storeId);
  await admin.from("incidents").delete().eq("sku", sku).eq("store_id", storeId);
  await admin.from("sales").delete().eq("sku", sku).eq("store_id", storeId);
  await admin.from("units").delete().eq("sku", sku).eq("store_id", storeId);
  await admin.from("sku_ledger").delete().eq("sku", sku).eq("store_id", storeId);
}

const { data: listed, error: listErr } = await admin
  .from("public_items")
  .select("store_id, sku, primary_photo_path, photo_paths")
  .limit(50);
if (listErr) throw new Error(`public_items: ${listErr.message}`);

const forSale = (listed ?? []).find((row) => pathsOf(row).length > 0);
if (!forSale) {
  console.error("No for-sale item with a photo in public_items. Import the backup first.");
  process.exit(1);
}
const forSalePath = pathsOf(forSale)[0];

let sold = await findSoldPhoto();
let createdThrowaway = false;
if (!sold) {
  sold = await createThrowawaySoldPhoto();
  createdThrowaway = true;
}

try {
  const { data: allowed, error: allowErr } = await admin.rpc("anon_can_read_unit_photo", {
    object_name: forSalePath,
  });
  const { data: denied, error: denyFnErr } = await admin.rpc("anon_can_read_unit_photo", {
    object_name: sold.path,
  });
  if (allowErr) throw new Error(allowErr.message);
  if (denyFnErr) throw new Error(denyFnErr.message);
  if (allowed !== true) {
    throw new Error(`anon_can_read_unit_photo(${forSalePath}) should be true, got ${allowed}`);
  }
  if (denied !== false) {
    throw new Error(`anon_can_read_unit_photo(${sold.path}) should be false, got ${denied}`);
  }

  const forSaleDl = await anon.storage.from("unit-photos").download(forSalePath);
  if (forSaleDl.error || !forSaleDl.data) {
    throw new Error(
      `anon should download for-sale ${forSale.sku} ${forSalePath}: ${forSaleDl.error?.message ?? "empty"}`,
    );
  }

  const soldDl = await anon.storage.from("unit-photos").download(sold.path);
  if (!soldDl.error) {
    throw new Error(`anon must not download sold ${sold.sku} ${sold.path}`);
  }

  const forSaleSign = await anon.storage.from("unit-photos").createSignedUrl(forSalePath, 60);
  if (forSaleSign.error || !forSaleSign.data?.signedUrl) {
    throw new Error(
      `anon should createSignedUrl for for-sale ${forSalePath}: ${forSaleSign.error?.message ?? "empty"}`,
    );
  }
  const signedGet = await fetch(forSaleSign.data.signedUrl);
  if (!signedGet.ok) {
    throw new Error(`for-sale signed URL returned ${signedGet.status}`);
  }

  const soldSign = await anon.storage.from("unit-photos").createSignedUrl(sold.path, 60);
  if (!soldSign.error) {
    throw new Error(`anon must not createSignedUrl for sold ${sold.sku} ${sold.path}`);
  }

  const publicUrl = `${url.replace(/\/$/, "")}/storage/v1/object/public/unit-photos/${forSalePath}`;
  const pub = await fetch(publicUrl);
  if (pub.ok) {
    throw new Error(`public bucket URL must be closed, got ${pub.status} from ${publicUrl}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        forSale: {
          sku: forSale.sku,
          path: forSalePath,
          bytes: forSaleDl.data.size,
          signedUrlOk: true,
        },
        sold: {
          sku: sold.sku,
          path: sold.path,
          downloadError: soldDl.error.message,
          signedUrlError: soldSign.error.message,
          throwaway: createdThrowaway,
        },
        publicUrlStatus: pub.status,
      },
      null,
      2,
    ),
  );
} finally {
  if (createdThrowaway) {
    await cleanupThrowaway(sold.sku, sold.path, sold.saleId, sold.storeId);
  }
}
