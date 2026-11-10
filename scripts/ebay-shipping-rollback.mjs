/**
 * Put the two corrected listings back on the package eBay had before the audit.
 * One command: node scripts/ebay-shipping-rollback.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEbayAccount, userTokenForAccount, ebayFetchAccount } from "../netlify/lib/ebay-accounts.mjs";
import { reviseFixedPricePackage } from "../netlify/lib/ebay-trading.mjs";

const cached = JSON.parse(readFileSync(path.join(process.env.TEMP || "", "netlify-env-inventoryobi.json"), "utf8"));
for (const row of cached) {
  if (!process.env[row.key] && row.values?.[0]?.value) process.env[row.key] = row.values[0].value;
}
process.env.EBAY_ENV = "production";

const backupPath = path.join("ops", "shipping-audit-2026-11-09", "backup.json");
const backup = JSON.parse(readFileSync(backupPath, "utf8"));
const rows = (backup.rows || []).filter((row) => row.applied);
if (!rows.length) {
  console.log(JSON.stringify({ restored: 0, reason: "nothing was changed" }));
  process.exit(0);
}

const account = await loadEbayAccount("5487ca47-6147-4fe8-bc6d-46b6472726ba", { username: "ikonikdeals2026" });
const token = await userTokenForAccount(account);
const restored = [];
for (const row of rows) {
  const box = row.originalPackage;
  if (!box) throw new Error(`backup for ${row.listingId} has no original package`);
  if (row.via === "inventory") {
    const current = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/inventory_item/${encodeURIComponent(row.sku)}`);
    const body = { ...current, packageWeightAndSize: row.originalInventoryPackage };
    delete body.sku;
    await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(row.sku)}`, body);
    if (row.offerId && row.fulfillmentPolicyId) {
      const offer = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer/${row.offerId}`);
      const offerBody = {
        ...offer,
        listingPolicies: { ...(offer.listingPolicies || {}), fulfillmentPolicyId: row.fulfillmentPolicyId },
      };
      delete offerBody.offerId;
      delete offerBody.listing;
      delete offerBody.status;
      await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/offer/${row.offerId}`, offerBody);
    }
  } else {
    await reviseFixedPricePackage(token, {
      itemId: row.listingId,
      lengthIn: box.lengthIn,
      widthIn: box.widthIn,
      heightIn: box.heightIn,
      weightLb: box.weightLb,
      fulfillmentPolicyId: row.fulfillmentPolicyId,
      paymentPolicyId: row.paymentPolicyId,
      returnPolicyId: row.returnPolicyId,
    }, account);
  }
  restored.push(row.listingId);
  console.log(JSON.stringify({ restored: row.listingId, sku: row.sku, via: row.via || "trading" }));
}
console.log(JSON.stringify({ restored: restored.length }));
