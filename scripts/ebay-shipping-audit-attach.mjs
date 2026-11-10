/**
 * Attach the new Ground-Advantage-first policy to the two corrected listings.
 * Does not edit the shared calculated policy and does not change price or title.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEbayAccount, ebayFetchAccount } from "../netlify/lib/ebay-accounts.mjs";

const cached = JSON.parse(readFileSync(path.join(process.env.TEMP || "", "netlify-env-inventoryobi.json"), "utf8"));
for (const row of cached) {
  if (!process.env[row.key] && row.values?.[0]?.value) process.env[row.key] = row.values[0].value;
}
process.env.EBAY_ENV = "production";

const POLICY_ID = "268664687017";
const backupPath = path.join("ops", "shipping-audit-2026-11-09", "backup.json");
const backup = JSON.parse(readFileSync(backupPath, "utf8"));
const account = await loadEbayAccount("5487ca47-6147-4fe8-bc6d-46b6472726ba", { username: "ikonikdeals2026" });

for (const record of backup.rows.filter((row) => row.applied)) {
  const found = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(record.sku)}`);
  const offer = found.offers?.[0];
  if (!offer?.offerId) {
    record.attachError = "no offer";
    writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(JSON.stringify({ stopped: true, sku: record.sku, error: "no offer" }));
    break;
  }
  const beforePrice = offer.pricingSummary?.price?.value || "";
  const body = {
    ...offer,
    listingPolicies: { ...(offer.listingPolicies || {}), fulfillmentPolicyId: POLICY_ID },
  };
  delete body.offerId;
  delete body.listing;
  delete body.status;
  try {
    await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/offer/${offer.offerId}`, body);
  } catch (err) {
    record.attachError = err instanceof Error ? err.message : String(err);
    writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(JSON.stringify({ stopped: true, sku: record.sku, error: record.attachError }));
    break;
  }
  const after = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer/${offer.offerId}`);
  const afterPrice = after.pricingSummary?.price?.value || "";
  record.offerId = offer.offerId;
  record.attachedPolicyId = after.listingPolicies?.fulfillmentPolicyId || "";
  if (afterPrice !== beforePrice) {
    record.attachError = `price changed ${beforePrice} -> ${afterPrice}`;
    const revert = { ...body, listingPolicies: offer.listingPolicies, pricingSummary: offer.pricingSummary };
    await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/offer/${offer.offerId}`, revert);
    writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(JSON.stringify({ stopped: true, sku: record.sku, error: record.attachError }));
    break;
  }
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(JSON.stringify({
    sku: record.sku,
    offerId: offer.offerId,
    price: afterPrice,
    policy: record.attachedPolicyId,
  }));
}
