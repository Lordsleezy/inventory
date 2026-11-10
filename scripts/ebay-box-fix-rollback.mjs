/**
 * Put the box corrections back to the packages saved before the fix.
 * One command: node scripts/ebay-box-fix-rollback.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadEbayAccount, userTokenForAccount, ebayFetchAccount } from "../netlify/lib/ebay-accounts.mjs";
import { reviseFixedPricePackage } from "../netlify/lib/ebay-trading.mjs";

const cached = JSON.parse(readFileSync(path.join(process.env.TEMP || "", "netlify-env-inventoryobi.json"), "utf8"));
for (const row of cached) {
  if (!process.env[row.key] && row.values?.[0]?.value) process.env[row.key] = row.values[0].value;
}
process.env.EBAY_ENV = "production";

const STORE = "5487ca47-6147-4fe8-bc6d-46b6472726ba";
const backupPath = path.join("ops", "shipping-audit-2026-11-09", "box-fix-backup.json");
const backup = JSON.parse(readFileSync(backupPath, "utf8"));
const rows = (backup.rows || []).filter((row) => row.appliedEbay || row.appliedFloor);
if (!rows.length) {
  console.log(JSON.stringify({ restored: 0, reason: "nothing was changed" }));
  process.exit(0);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const account = await loadEbayAccount(STORE, { username: "ikonikdeals2026" });
const token = await userTokenForAccount(account);
const restored = [];

for (const row of rows) {
  if (row.appliedEbay) {
    if (row.via === "inventory" && row.originalInventoryPackage) {
      const current = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/inventory_item/${encodeURIComponent(row.sku)}`);
      const body = { ...current, packageWeightAndSize: row.originalInventoryPackage };
      delete body.sku;
      await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(row.sku)}`, body);
    } else if (row.originalPackage) {
      await reviseFixedPricePackage(token, { itemId: row.listingId, ...row.originalPackage }, account);
    }
    row.appliedEbay = false;
  }
  const before = row.floorBefore;
  if (row.appliedFloor && before) {
    const { error } = await sb
      .from("units")
      .update({
        package_length_in: before.package_length_in,
        package_width_in: before.package_width_in,
        package_height_in: before.package_height_in,
        package_weight_lb: before.package_weight_lb,
      })
      .eq("store_id", STORE)
      .eq("sku", row.sku);
    if (error) throw new Error(error.message);
    row.appliedFloor = false;
  }
  restored.push(row.sku);
}
writeFileSync(backupPath, JSON.stringify(backup, null, 2));
console.log(JSON.stringify({ restored }, null, 2));
