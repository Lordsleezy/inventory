/**
 * Write 400px / 1200px WebP copies next to existing originals.
 * Originals are left in place. Does not insert rows into photos.
 */
import "./load-env.mjs";
import { createServiceClient } from "@floor/cloud";
import { removeWebDerivatives, syncWebDerivatives } from "./web-derivatives.mjs";

const force = process.argv.includes("--force");

async function exists(client, key) {
  const { data } = await client.storage.from("unit-photos").createSignedUrl(key, 30);
  return Boolean(data?.signedUrl);
}

const client = createServiceClient();
const storeId = (process.env.STORE_ID || process.env.NEXT_PUBLIC_STORE_ID || "").trim();
if (!storeId) throw new Error("Set STORE_ID (or NEXT_PUBLIC_STORE_ID) in .env.local.");
const { data, error } = await client.from("photos").select("id, sku, path").eq("store_id", storeId);
if (error) throw new Error(error.message);

const rows = (data ?? []).filter((row) => {
  const path = String(row.path || "").replace(/\\/g, "/");
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 3 && parts[0] === storeId && parts[1] !== "archive" && parts[2] !== "web";
});

const summary = { wrote: 0, skipped: 0, failed: [] };
for (const row of rows) {
  const live = String(row.path);
  try {
    const thumb = `${live.split("/").slice(0, 2).join("/")}/web/400/${(live.split("/").pop() || "photo").replace(/\.[^.]+$/, "")}.webp`;
    if (!force && (await exists(client, thumb))) {
      summary.skipped += 1;
      continue;
    }
    const dl = await client.storage.from("unit-photos").download(live);
    if (dl.error || !dl.data) throw new Error(dl.error?.message || "empty download");
    const bytes = Buffer.from(await dl.data.arrayBuffer());
    if (force) await removeWebDerivatives(client, live).catch(() => undefined);
    await syncWebDerivatives(client, live, bytes);
    summary.wrote += 1;
  } catch (err) {
    summary.failed.push({ sku: row.sku, path: live, reason: err instanceof Error ? err.message : String(err) });
  }
}

console.log(JSON.stringify(summary, null, 2));
