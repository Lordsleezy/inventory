/**
 * After migrate + import, confirm every photos.path exists in Storage.
 *
 *   set SUPABASE_URL=https://zoukmsmbztcuyoslvikp.supabase.co
 *   set SUPABASE_SERVICE_ROLE=...
 *   set STORE_ID=...
 *   node --experimental-strip-types scripts/verify-photos.mjs
 */
import "./load-env.mjs";
import { createServiceClient } from "@floor/cloud";

const storeId = process.env.STORE_ID;
if (!storeId) {
  console.error("Set STORE_ID.");
  process.exit(1);
}

const client = createServiceClient();
const { data, error } = await client.rpc("verify_unit_photos", { p_store: storeId });
if (error) {
  console.error(error.message);
  process.exit(1);
}

const rows = data ?? [];
const missing = rows.filter((r) => !r.storage_ok);
for (const row of rows) {
  if (!row.storage_ok) continue;
  const dl = await client.storage.from("unit-photos").download(row.path);
  if (dl.error || !dl.data) {
    missing.push({ ...row, storage_ok: false });
  }
}

if (missing.length) {
  console.error(JSON.stringify({ ok: false, missing }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, photos: rows.length, storeId }, null, 2));
