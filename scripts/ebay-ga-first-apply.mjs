/**
 * Put USPS Ground Advantage first on calculated buyer-pays policies.
 * One policy at a time. Stops on the first eBay error. Does not change
 * handling time, package handling cost, prices, or the combined-weight rule.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEbayAccount, ebayFetchAccount } from "../netlify/lib/ebay-accounts.mjs";

const cached = JSON.parse(readFileSync(path.join(process.env.TEMP, "netlify-env-inventoryobi.json"), "utf8"));
for (const row of cached) {
  if (!process.env[row.key] && row.values?.[0]?.value) process.env[row.key] = row.values[0].value;
}
process.env.EBAY_ENV = "production";

const STORE = "5487ca47-6147-4fe8-bc6d-46b6472726ba";
const DIR = path.join("ops", "shipping-audit-2026-11-09");
const RANK = { USPSParcel: 1, USPSPriority: 2, USPSExpressMail: 3 };

const account = await loadEbayAccount(STORE, { username: "ikonikdeals2026" });
if (String(account.username).toLowerCase() !== "ikonikdeals2026") {
  throw new Error(`refusing account ${account.username}`);
}

function serviceOrder(services) {
  const next = services.map((svc) => ({ ...svc }));
  if (!next.some((svc) => svc.shippingServiceCode === "USPSParcel")) {
    next.unshift({
      sortOrder: 1,
      shippingCarrierCode: "USPS",
      shippingServiceCode: "USPSParcel",
      freeShipping: false,
      buyerResponsibleForShipping: false,
      buyerResponsibleForPickup: false,
    });
  }
  next.sort((a, b) => (RANK[a.shippingServiceCode] ?? 50) - (RANK[b.shippingServiceCode] ?? 50) || Number(a.sortOrder) - Number(b.sortOrder));
  return next.map((svc, index) => ({ ...svc, sortOrder: index + 1 }));
}

function sameOrder(before, after) {
  return before.map((svc) => svc.shippingServiceCode).join(",") === after.map((svc) => svc.shippingServiceCode).join(",");
}

function domestic(policy) {
  return (policy.shippingOptions || []).find((opt) => opt.optionType === "DOMESTIC") || null;
}

function needsChange(policy) {
  const option = domestic(policy);
  if (!option || option.costType !== "CALCULATED") return false;
  const services = option.shippingServices || [];
  if (!services.length) return false;
  if (services.length === 1 && services[0].freeShipping) return false;
  return !sameOrder(services, serviceOrder(services));
}

function putBody(policy) {
  return {
    name: policy.name,
    marketplaceId: policy.marketplaceId || "EBAY_US",
    categoryTypes: (policy.categoryTypes || [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }]).map((row) => ({
      name: row.name,
    })),
    ...(policy.handlingTime ? { handlingTime: policy.handlingTime } : {}),
    localPickup: Boolean(policy.localPickup),
    freightShipping: Boolean(policy.freightShipping),
    pickupDropOff: Boolean(policy.pickupDropOff),
    globalShipping: Boolean(policy.globalShipping),
    shippingOptions: (policy.shippingOptions || []).map((opt) => {
      const services = opt.optionType === "DOMESTIC" && opt.costType === "CALCULATED" && (opt.shippingServices || []).length
        && !(opt.shippingServices.length === 1 && opt.shippingServices[0].freeShipping)
        ? serviceOrder(opt.shippingServices)
        : opt.shippingServices;
      return {
        optionType: opt.optionType,
        costType: opt.costType,
        ...(opt.packageHandlingCost ? { packageHandlingCost: opt.packageHandlingCost } : {}),
        ...(opt.shippingDiscountProfileId != null ? { shippingDiscountProfileId: opt.shippingDiscountProfileId } : {}),
        ...(opt.shippingPromotionOffered != null ? { shippingPromotionOffered: opt.shippingPromotionOffered } : {}),
        shippingServices: (services || []).map((svc) => ({
          sortOrder: svc.sortOrder,
          shippingCarrierCode: svc.shippingCarrierCode,
          shippingServiceCode: svc.shippingServiceCode,
          freeShipping: Boolean(svc.freeShipping),
          buyerResponsibleForShipping: Boolean(svc.buyerResponsibleForShipping),
          buyerResponsibleForPickup: Boolean(svc.buyerResponsibleForPickup),
          ...(svc.shippingCost ? { shippingCost: svc.shippingCost } : {}),
          ...(svc.additionalShippingCost ? { additionalShippingCost: svc.additionalShippingCost } : {}),
        })),
      };
    }),
  };
}

function summary(policy) {
  const option = domestic(policy);
  return {
    id: String(policy.fulfillmentPolicyId || ""),
    name: policy.name,
    handling: policy.handlingTime || null,
    packageHandlingCost: option?.packageHandlingCost?.value ?? null,
    services: (option?.shippingServices || []).map((svc) => `${svc.sortOrder}:${svc.shippingServiceCode}`),
  };
}

const listed = await ebayFetchAccount(account, "GET", "/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US");
const full = [];
for (const row of listed.fulfillmentPolicies || []) {
  const id = String(row.fulfillmentPolicyId || "");
  full.push(await ebayFetchAccount(account, "GET", `/sell/account/v1/fulfillment_policy/${id}`));
}

mkdirSync(DIR, { recursive: true });
const backupPath = path.join(DIR, "ga-first-backup.json");
const backup = readFileSync(backupPath, "utf8").trim()
  ? JSON.parse(readFileSync(backupPath, "utf8"))
  : {
      createdAt: new Date().toISOString(),
      account: "ikonikdeals2026",
      note: "Calculated buyer-pays policies reordered so USPS Ground Advantage (USPSParcel) is service 1. Handling time, package handling cost, and the combined-weight rule were not changed.",
      policies: full.map((policy) => ({
        id: String(policy.fulfillmentPolicyId),
        name: policy.name,
        applied: false,
        original: policy,
      })),
    };
if (!backup.policies?.length) throw new Error("backup has no policies");
writeFileSync(backupPath, JSON.stringify(backup, null, 2));

const targets = backup.policies.filter((row) => needsChange(row.original));
console.log(JSON.stringify({
  backedUp: backup.policies.length,
  willChange: targets.map((row) => summary(row.original)),
}, null, 2));

for (const row of targets) {
  if (row.applied) {
    console.log(JSON.stringify({ already: true, id: row.id, name: row.name }));
    continue;
  }
  const before = summary(row.original);
  const body = putBody(row.original);
  try {
    await ebayFetchAccount(account, "PUT", `/sell/account/v1/fulfillment_policy/${row.id}`, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Duplicate Policy/i.test(message)) {
      row.skipped = "duplicate";
      row.error = message;
      writeFileSync(backupPath, JSON.stringify(backup, null, 2));
      console.log(JSON.stringify({ skipped: true, id: row.id, name: row.name, reason: "eBay already has this service list on another policy", error: message }));
      continue;
    }
    row.error = message;
    writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(JSON.stringify({ stopped: true, id: row.id, name: row.name, error: row.error }));
    process.exit(1);
  }
  const read = await ebayFetchAccount(account, "GET", `/sell/account/v1/fulfillment_policy/${row.id}`);
  const after = summary(read);
  const handlingSame = JSON.stringify(before.handling) === JSON.stringify(after.handling);
  const costSame = String(before.packageHandlingCost) === String(after.packageHandlingCost);
  const parcelFirst = after.services[0] === "1:USPSParcel";
  if (!handlingSame || !costSame || !parcelFirst || after.name !== before.name) {
    row.error = `read-back mismatch ${JSON.stringify(after)}`;
    row.applied = true;
    writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(JSON.stringify({ stopped: true, id: row.id, error: row.error }));
    process.exit(1);
  }
  row.applied = true;
  row.readBack = after;
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(JSON.stringify({ id: row.id, name: row.name, from: before.services, to: after.services, handling: after.handling, packageHandlingCost: after.packageHandlingCost }));
}
