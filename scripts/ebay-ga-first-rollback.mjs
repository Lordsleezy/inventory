/**
 * Put the calculated shipping policies back to the service order saved before
 * Ground Advantage was moved first.
 * One command: node scripts/ebay-ga-first-rollback.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEbayAccount, userTokenForAccount, ebayFetchAccount } from "../netlify/lib/ebay-accounts.mjs";
import { reviseFixedPricePriceAndShipping } from "../netlify/lib/ebay-trading.mjs";

const cached = JSON.parse(readFileSync(path.join(process.env.TEMP || "", "netlify-env-inventoryobi.json"), "utf8"));
for (const row of cached) {
  if (!process.env[row.key] && row.values?.[0]?.value) process.env[row.key] = row.values[0].value;
}
process.env.EBAY_ENV = "production";

const STORE = "5487ca47-6147-4fe8-bc6d-46b6472726ba";
const backupPath = path.join("ops", "shipping-audit-2026-11-09", "ga-first-backup.json");
const backup = JSON.parse(readFileSync(backupPath, "utf8"));
const rows = (backup.policies || []).filter((row) => row.applied);
const moves = (backup.listingMoves || []).filter((row) => row.applied);
if (!rows.length && !moves.length) {
  console.log(JSON.stringify({ restored: 0, reason: "nothing was changed" }));
  process.exit(0);
}

const account = await loadEbayAccount(STORE, { username: "ikonikdeals2026" });
if (String(account.username).toLowerCase() !== "ikonikdeals2026") {
  throw new Error(`refusing account ${account.username}`);
}
const token = await userTokenForAccount(account);

function putBody(policy) {
  const option = (policy.shippingOptions || [])[0];
  return {
    name: policy.name,
    marketplaceId: policy.marketplaceId || "EBAY_US",
    categoryTypes: (policy.categoryTypes || [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }]).map((row) => ({ name: row.name })),
    ...(policy.handlingTime ? { handlingTime: policy.handlingTime } : {}),
    localPickup: Boolean(policy.localPickup),
    freightShipping: Boolean(policy.freightShipping),
    pickupDropOff: Boolean(policy.pickupDropOff),
    globalShipping: Boolean(policy.globalShipping),
    shippingOptions: (policy.shippingOptions || []).map((opt) => ({
      optionType: opt.optionType,
      costType: opt.costType,
      ...(opt.packageHandlingCost ? { packageHandlingCost: opt.packageHandlingCost } : {}),
      ...(opt.shippingDiscountProfileId != null ? { shippingDiscountProfileId: opt.shippingDiscountProfileId } : {}),
      ...(opt.shippingPromotionOffered != null ? { shippingPromotionOffered: opt.shippingPromotionOffered } : {}),
      shippingServices: (opt.shippingServices || []).map((svc) => ({
        sortOrder: svc.sortOrder,
        shippingCarrierCode: svc.shippingCarrierCode,
        shippingServiceCode: svc.shippingServiceCode,
        freeShipping: Boolean(svc.freeShipping),
        buyerResponsibleForShipping: Boolean(svc.buyerResponsibleForShipping),
        buyerResponsibleForPickup: Boolean(svc.buyerResponsibleForPickup),
        ...(svc.shippingCost ? { shippingCost: svc.shippingCost } : {}),
        ...(svc.additionalShippingCost ? { additionalShippingCost: svc.additionalShippingCost } : {}),
      })),
    })),
  };
  void option;
}

const restored = [];
for (const move of moves) {
  if (move.via === "inventory" && move.offerId) {
    const current = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer/${move.offerId}`);
    const body = {
      ...current,
      listingPolicies: { ...(current.listingPolicies || {}), fulfillmentPolicyId: move.fromPolicyId },
    };
    delete body.offerId;
    await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/offer/${move.offerId}`, body);
  } else {
    await reviseFixedPricePriceAndShipping(token, {
      itemId: move.listingId,
      fulfillmentPolicyId: move.fromPolicyId,
      paymentPolicyId: move.payment,
      returnPolicyId: move.returns,
    }, account);
  }
  move.applied = false;
  restored.push(move.listingId);
}
for (const row of rows) {
  await ebayFetchAccount(account, "PUT", `/sell/account/v1/fulfillment_policy/${row.id}`, putBody(row.original));
  row.applied = false;
  restored.push(row.id);
}
for (const row of backup.refreshed || []) {
  if (row.via === "inventory" && row.offerId) {
    const current = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer/${row.offerId}`);
    const body = {
      ...current,
      listingPolicies: { ...(current.listingPolicies || {}), fulfillmentPolicyId: row.policyId },
    };
    delete body.offerId;
    await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/offer/${row.offerId}`, body);
  } else if (row.policyId && row.payment && row.returns) {
    await reviseFixedPricePriceAndShipping(token, {
      itemId: row.listingId,
      fulfillmentPolicyId: row.policyId,
      paymentPolicyId: row.payment,
      returnPolicyId: row.returns,
    }, account);
  }
  restored.push(row.listingId);
}
writeFileSync(backupPath, JSON.stringify(backup, null, 2));
console.log(JSON.stringify({ restored }, null, 2));
