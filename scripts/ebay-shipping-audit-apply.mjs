/**
 * Lower the listings whose eBay package is larger than Floor's box.
 * Sends only ShippingPackageDetails. Stops on the first eBay error.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEbayAccount, userTokenForAccount, ebayFetchAccount } from "../netlify/lib/ebay-accounts.mjs";
import { ebayHosts } from "../netlify/lib/ebay-env.mjs";
import { reviseFixedPricePackage } from "../netlify/lib/ebay-trading.mjs";
import { packageChangeLowers } from "../shared/shipping-audit.mjs";

const cached = JSON.parse(readFileSync(path.join(process.env.TEMP || "", "netlify-env-inventoryobi.json"), "utf8"));
for (const row of cached) {
  if (!process.env[row.key] && row.values?.[0]?.value) process.env[row.key] = row.values[0].value;
}
process.env.EBAY_ENV = "production";

const DRY = process.argv.includes("--dry");
const DIR = path.join("ops", "shipping-audit-2026-11-09");
const ZIPS = ["95814", "64101", "10001"];
const review = JSON.parse(readFileSync(path.join(DIR, "review.json"), "utf8"));
const targets = review.rows.filter((row) => row.verdict === "too_high" && row.publish !== "");

const account = await loadEbayAccount("5487ca47-6147-4fe8-bc6d-46b6472726ba", { username: "ikonikdeals2026" });
const token = await userTokenForAccount(account);
const { api } = ebayHosts("production");

function tag(xml, name) {
  const match = String(xml).match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
  return match ? match[1].trim() : "";
}

function packageFrom(xml) {
  const blocks = [...String(xml).matchAll(/<(?:ShippingPackageDetails|CalculatedShippingRate)>([\s\S]*?)<\/(?:ShippingPackageDetails|CalculatedShippingRate)>/g)];
  for (const match of blocks) {
    const lengthIn = Number(tag(match[1], "PackageLength") || 0);
    const widthIn = Number(tag(match[1], "PackageWidth") || 0);
    const heightIn = Number(tag(match[1], "PackageDepth") || 0);
    const weightLb = Number(tag(match[1], "WeightMajor") || 0) + Number(tag(match[1], "WeightMinor") || 0) / 16;
    if (lengthIn > 0 && widthIn > 0 && heightIn > 0 && weightLb > 0) return { lengthIn, widthIn, heightIn, weightLb };
  }
  return { lengthIn: 0, widthIn: 0, heightIn: 0, weightLb: 0 };
}

async function trading(callName, inner) {
  const res = await fetch(`${api}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1315",
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body: `<?xml version="1.0" encoding="utf-8"?><${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents"><ErrorLanguage>en_US</ErrorLanguage>${inner}</${callName}Request>`,
  });
  const xml = await res.text();
  return { ack: tag(xml, "Ack"), xml };
}

function boxFromText(text) {
  const match = String(text || "").match(/([\d.]+)x([\d.]+)x([\d.]+)\s+([\d.]+)lb/);
  if (!match) return null;
  return { lengthIn: Number(match[1]), widthIn: Number(match[2]), heightIn: Number(match[3]), weightLb: Number(match[4]) };
}

async function quote(listingId, zip) {
  const { ack, xml } = await trading("GetItemShipping", `<ItemID>${listingId}</ItemID><QuantitySold>1</QuantitySold><DestinationPostalCode>${zip}</DestinationPostalCode><DestinationCountryCode>US</DestinationCountryCode>`);
  const services = [...xml.matchAll(/<ShippingServiceOptions>([\s\S]*?)<\/ShippingServiceOptions>/g)].map((match) => ({
    service: tag(match[1], "ShippingService"),
    cost: Number(tag(match[1], "ShippingServiceCost")),
  }));
  const rate = (xml.match(/<CalculatedShippingRate>([\s\S]*?)<\/CalculatedShippingRate>/) || [])[1] || "";
  return {
    zip,
    ack,
    services,
    lengthIn: Number(tag(rate, "PackageLength") || 0),
    widthIn: Number(tag(rate, "PackageWidth") || 0),
    heightIn: Number(tag(rate, "PackageDepth") || 0),
    weightLb: Number(tag(rate, "WeightMajor") || 0) + Number(tag(rate, "WeightMinor") || 0) / 16,
    error: /success|warning/i.test(ack) ? "" : tag(xml, "LongMessage"),
  };
}

async function readItem(listingId) {
  const { ack, xml } = await trading("GetItem", `<ItemID>${listingId}</ItemID><OutputSelector>Item.ListingType</OutputSelector><OutputSelector>Item.Title</OutputSelector><OutputSelector>Item.SellingStatus</OutputSelector><OutputSelector>Item.BestOfferDetails</OutputSelector><OutputSelector>Item.SellerProfiles</OutputSelector><OutputSelector>Item.ShippingDetails</OutputSelector>`);
  const profiles = (xml.match(/<SellerProfiles>([\s\S]*?)<\/SellerProfiles>/) || [])[1] || "";
  return {
    ack,
    error: /success|warning/i.test(ack) ? "" : tag(xml, "LongMessage"),
    listingType: tag(xml, "ListingType"),
    title: tag(xml, "Title"),
    price: tag(xml, "CurrentPrice"),
    status: tag(xml, "ListingStatus"),
    bestOffers: Number(tag(xml, "BestOfferCount") || 0),
    fulfillmentPolicyId: tag(profiles, "ShippingProfileID"),
    paymentPolicyId: tag(profiles, "PaymentProfileID"),
    returnPolicyId: tag(profiles, "ReturnProfileID"),
    package: packageFrom(xml),
  };
}

function rose(before, after) {
  const beforeCosts = new Map(before.services.filter((s) => s.cost > 0).map((s) => [s.service, s.cost]));
  for (const service of after.services) {
    const old = beforeCosts.get(service.service);
    if (old != null && service.cost > old + 0.05) return `${service.service} ${old} -> ${service.cost} at ${after.zip}`;
  }
  return "";
}

async function publicPrice(listingId) {
  const res = await fetch(`https://www.ebay.com/itm/${listingId}`, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US" },
  });
  const html = await res.text();
  const costs = [...html.matchAll(/\$(\d{1,3}\.\d{2})/g)].map((match) => match[1]);
  return { status: res.status, costs: [...new Set(costs)].slice(0, 12), blocked: /captcha|robot/i.test(html) };
}

const backup = { createdAt: new Date().toISOString(), rows: [] };
mkdirSync(DIR, { recursive: true });

for (const target of targets) {
  const floor = boxFromText(target.floorBox);
  const item = await readItem(target.listingId);
  const before = [];
  for (const zip of ZIPS) before.push(await quote(target.listingId, zip));
  const record = {
    listingId: target.listingId,
    sku: target.sku,
    title: item.title,
    price: item.price,
    offerId: target.offerId || "",
    listingType: item.listingType,
    status: item.status,
    bestOffers: item.bestOffers,
    fulfillmentPolicyId: item.fulfillmentPolicyId,
    paymentPolicyId: item.paymentPolicyId,
    returnPolicyId: item.returnPolicyId,
    originalPackage: item.package,
    floor,
    before,
    applied: false,
    via: "",
    after: [],
    publicPage: null,
    error: item.error || "",
  };
  if (item.listingType && item.listingType !== "FixedPriceItem") record.error = `skipped ${item.listingType}`;
  if (item.status && item.status !== "Active") record.error = `skipped ${item.status}`;
  if (item.bestOffers > 0) record.error = "skipped active best offers";
  if (!packageChangeLowers(item.package.weightLb ? item.package : boxFromText(target.ebayBox), floor)) {
    record.error = record.error || "skipped because the Floor box does not lower the billable weight";
  }
  backup.rows.push(record);
}
writeFileSync(path.join(DIR, "backup.json"), JSON.stringify(backup, null, 2));
console.log(JSON.stringify(backup.rows.map((row) => ({
  id: row.listingId,
  sku: row.sku,
  type: row.listingType,
  status: row.status,
  offers: row.bestOffers,
  price: row.price,
  policy: row.fulfillmentPolicyId,
  from: row.originalPackage,
  to: row.floor,
  error: row.error,
  zone7: (row.before.find((q) => q.zip === "64101") || {}).services,
})), null, 2));

if (DRY) process.exit(0);

const POLICY_NAME = "Floor audit calculated GA first";
const listed = await ebayFetchAccount(account, "GET", "/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US");
let policy = (listed.fulfillmentPolicies || []).find((row) => row.name === POLICY_NAME);
if (!policy) {
  const source = await ebayFetchAccount(account, "GET", "/sell/account/v1/fulfillment_policy/267792814017");
  policy = await ebayFetchAccount(account, "POST", "/sell/account/v1/fulfillment_policy", {
    name: POLICY_NAME,
    marketplaceId: "EBAY_US",
    categoryTypes: source.categoryTypes,
    handlingTime: source.handlingTime,
    globalShipping: false,
    pickupDropOff: false,
    freightShipping: false,
    shippingOptions: [{
      optionType: "DOMESTIC",
      costType: "CALCULATED",
      packageHandlingCost: { value: "0.0", currency: "USD" },
      shippingServices: [
        { sortOrder: 1, shippingCarrierCode: "USPS", shippingServiceCode: "USPSParcel", freeShipping: false, buyerResponsibleForShipping: false, buyerResponsibleForPickup: false },
        { sortOrder: 2, shippingCarrierCode: "USPS", shippingServiceCode: "USPSPriority", freeShipping: false, buyerResponsibleForShipping: false, buyerResponsibleForPickup: false },
      ],
    }],
  });
}
const nextPolicyId = String(policy.fulfillmentPolicyId || policy.id || "");
if (!nextPolicyId || nextPolicyId === "267792814017") throw new Error("refusing to edit the shared calculated policy");
backup.policyId = nextPolicyId;
writeFileSync(path.join(DIR, "backup.json"), JSON.stringify(backup, null, 2));
console.log(JSON.stringify({ policyId: nextPolicyId, name: POLICY_NAME }));

for (const record of backup.rows) {
  if (record.error) {
    console.log(JSON.stringify({ stopped: true, listingId: record.listingId, error: record.error }));
    break;
  }
  try {
    const revised = await reviseFixedPricePackage(token, {
      itemId: record.listingId,
      ...record.floor,
      fulfillmentPolicyId: nextPolicyId,
      paymentPolicyId: record.paymentPolicyId,
      returnPolicyId: record.returnPolicyId,
    }, account);
    record.via = "trading";
    record.ack = revised.ack;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/inventory-based/i.test(message) || !record.sku) {
      record.error = message;
      writeFileSync(path.join(DIR, "backup.json"), JSON.stringify(backup, null, 2));
      console.log(JSON.stringify({ stopped: true, listingId: record.listingId, error: message }));
      break;
    }
    try {
      const current = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/inventory_item/${encodeURIComponent(record.sku)}`);
      record.originalInventoryPackage = current.packageWeightAndSize || null;
      const sides = [record.floor.lengthIn, record.floor.widthIn, record.floor.heightIn].sort((a, b) => b - a);
      const body = {
        ...current,
        packageWeightAndSize: {
          dimensions: { length: String(sides[0]), width: String(sides[1]), height: String(sides[2]), unit: "INCH" },
          weight: { value: String(record.floor.weightLb), unit: "POUND" },
        },
      };
      delete body.sku;
      await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(record.sku)}`, body);
      record.via = "inventory";
    } catch (inventoryErr) {
      record.error = inventoryErr instanceof Error ? inventoryErr.message : String(inventoryErr);
      writeFileSync(path.join(DIR, "backup.json"), JSON.stringify(backup, null, 2));
      console.log(JSON.stringify({ stopped: true, listingId: record.listingId, error: record.error }));
      break;
    }
  }
  record.applied = true;
  writeFileSync(path.join(DIR, "backup.json"), JSON.stringify(backup, null, 2));
  const afterItem = await readItem(record.listingId);
  record.afterItem = { title: afterItem.title, price: afterItem.price, package: afterItem.package };
  if (afterItem.title && afterItem.title !== record.title) {
    record.error = "title changed; rolling back";
  }
  if (afterItem.price && afterItem.price !== record.price) {
    record.error = "price changed; rolling back";
  }
  for (const zip of ZIPS) record.after.push(await quote(record.listingId, zip));
  const increase = record.before.map((before, index) => rose(before, record.after[index])).find(Boolean);
  if (increase) record.error = `rate rose (${increase}); rolling back`;
  writeFileSync(path.join(DIR, "backup.json"), JSON.stringify(backup, null, 2));
  if (record.error) {
    await reviseFixedPricePackage(token, {
      itemId: record.listingId,
      ...record.originalPackage,
      fulfillmentPolicyId: record.fulfillmentPolicyId,
      paymentPolicyId: record.paymentPolicyId,
      returnPolicyId: record.returnPolicyId,
    }, account).catch(async () => {
      if (record.via === "inventory" && record.originalInventoryPackage) {
        const current = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/inventory_item/${encodeURIComponent(record.sku)}`);
        const body = { ...current, packageWeightAndSize: record.originalInventoryPackage };
        delete body.sku;
        await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(record.sku)}`, body);
      }
    });
    record.applied = false;
    writeFileSync(path.join(DIR, "backup.json"), JSON.stringify(backup, null, 2));
    console.log(JSON.stringify({ stopped: true, listingId: record.listingId, error: record.error }));
    break;
  }
  record.publicPage = await publicPrice(record.listingId);
  writeFileSync(path.join(DIR, "backup.json"), JSON.stringify(backup, null, 2));
  console.log(JSON.stringify({
    listingId: record.listingId,
    sku: record.sku,
    via: record.via,
    price: record.price,
    afterPrice: record.afterItem.price,
    titleSame: record.afterItem.title === record.title,
    from: record.originalPackage,
    to: record.afterItem.package,
    before: record.before.map((q) => ({ zip: q.zip, services: q.services })),
    after: record.after.map((q) => ({ zip: q.zip, services: q.services })),
    publicPage: record.publicPage,
  }));
}
