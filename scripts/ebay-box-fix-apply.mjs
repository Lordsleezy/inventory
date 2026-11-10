/**
 * Correct the copied rug boxes and the two Floor-only sizes.
 * Sends package dimensions only. Stops on the first eBay error.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadEbayAccount, userTokenForAccount, ebayFetchAccount } from "../netlify/lib/ebay-accounts.mjs";
import { ebayHosts } from "../netlify/lib/ebay-env.mjs";
import { reviseFixedPricePackage } from "../netlify/lib/ebay-trading.mjs";

const cached = JSON.parse(readFileSync(path.join(process.env.TEMP, "netlify-env-inventoryobi.json"), "utf8"));
for (const row of cached) {
  if (!process.env[row.key] && row.values?.[0]?.value) process.env[row.key] = row.values[0].value;
}
process.env.EBAY_ENV = "production";

const STORE = "5487ca47-6147-4fe8-bc6d-46b6472726ba";
const DIR = path.join("ops", "shipping-audit-2026-11-09");
const ZIPS = ["95814", "64101"];
const targets = [
  { sku: "11411", listingId: "820244178464", lengthIn: 12.4, widthIn: 9.4, heightIn: 4.1, weightLb: 2.36, ebay: true },
  { sku: "11225", listingId: "820244205252", lengthIn: 14, widthIn: 12, heightIn: 3, weightLb: 1.5, ebay: true },
  { sku: "99099", listingId: "820244222666", lengthIn: 37.8, widthIn: 7.9, heightIn: 5.1, weightLb: 5.4, ebay: true },
  { sku: "99091", listingId: "820256317725", lengthIn: 11.5, widthIn: 9, heightIn: 6, weightLb: 3.7, ebay: true },
  { sku: "11489", listingId: "820244238978", lengthIn: 10, widthIn: 6, heightIn: 5, weightLb: 1.5, ebay: true },
  { sku: "99698", listingId: "820253037114", lengthIn: 12, widthIn: 9, heightIn: 4, weightLb: 2, ebay: false },
  { sku: "11169", listingId: "820244299631", lengthIn: 24, widthIn: 20, heightIn: 12, weightLb: 38, ebay: false },
];

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const account = await loadEbayAccount(STORE, { username: "ikonikdeals2026" });
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
  return null;
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
  return { ack: tag(xml, "Ack"), xml, error: /success|warning/i.test(tag(xml, "Ack")) ? "" : tag(xml, "LongMessage") };
}
async function readItem(listingId) {
  const { xml, error } = await trading("GetItem", `<ItemID>${listingId}</ItemID><OutputSelector>Item.Title</OutputSelector><OutputSelector>Item.SellingStatus</OutputSelector><OutputSelector>Item.ShippingDetails</OutputSelector><OutputSelector>Item.SellerProfiles</OutputSelector>`);
  const profiles = (xml.match(/<SellerProfiles>([\s\S]*?)<\/SellerProfiles>/) || [])[1] || "";
  return {
    error,
    title: tag(xml, "Title"),
    price: tag(xml, "CurrentPrice"),
    policy: tag(profiles, "ShippingProfileID"),
    box: packageFrom(xml),
  };
}
async function quote(listingId, zip) {
  const { xml, error } = await trading("GetItemShipping", `<ItemID>${listingId}</ItemID><QuantitySold>1</QuantitySold><DestinationPostalCode>${zip}</DestinationPostalCode><DestinationCountryCode>US</DestinationCountryCode>`);
  return {
    zip,
    error,
    services: [...xml.matchAll(/<ShippingServiceOptions>([\s\S]*?)<\/ShippingServiceOptions>/g)].map((m) => ({
      service: tag(m[1], "ShippingService"),
      cost: Number(tag(m[1], "ShippingServiceCost")),
    })),
  };
}
function inventoryPackage(box) {
  const sides = [box.lengthIn, box.widthIn, box.heightIn].map(Number).sort((a, b) => b - a);
  return {
    dimensions: { length: String(sides[0]), width: String(sides[1]), height: String(sides[2]), unit: "INCH" },
    weight: { value: String(box.weightLb), unit: "POUND" },
  };
}

mkdirSync(DIR, { recursive: true });
const backup = { createdAt: new Date().toISOString(), rows: [] };

for (const target of targets) {
  const { data: unit, error: unitError } = await sb
    .from("units")
    .select("sku, title, package_length_in, package_width_in, package_height_in, package_weight_lb")
    .eq("store_id", STORE)
    .eq("sku", target.sku)
    .maybeSingle();
  if (unitError) throw new Error(unitError.message);
  const item = await readItem(target.listingId);
  const before = [];
  for (const zip of ZIPS) before.push(await quote(target.listingId, zip));
  const record = {
    ...target,
    floorBefore: unit,
    title: item.title,
    price: item.price,
    policy: item.policy,
    originalPackage: item.box,
    before,
    appliedEbay: false,
    appliedFloor: false,
    via: "",
    error: item.error || "",
  };
  backup.rows.push(record);
}
writeFileSync(path.join(DIR, "box-fix-backup.json"), JSON.stringify(backup, null, 2));

for (const record of backup.rows) {
  if (record.error) {
    console.log(JSON.stringify({ stopped: true, sku: record.sku, error: record.error }));
    break;
  }
  const next = { lengthIn: record.lengthIn, widthIn: record.widthIn, heightIn: record.heightIn, weightLb: record.weightLb };
  if (record.ebay) {
    try {
      await reviseFixedPricePackage(token, { itemId: record.listingId, ...next }, account);
      record.via = "trading";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/inventory-based/i.test(message)) {
        record.error = message;
        writeFileSync(path.join(DIR, "box-fix-backup.json"), JSON.stringify(backup, null, 2));
        console.log(JSON.stringify({ stopped: true, sku: record.sku, error: message }));
        break;
      }
      const current = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/inventory_item/${encodeURIComponent(record.sku)}`);
      record.originalInventoryPackage = current.packageWeightAndSize || null;
      const body = { ...current, packageWeightAndSize: { ...(current.packageWeightAndSize || {}), ...inventoryPackage(next) } };
      delete body.sku;
      await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(record.sku)}`, body);
      record.via = "inventory";
    }
    record.appliedEbay = true;
    writeFileSync(path.join(DIR, "box-fix-backup.json"), JSON.stringify(backup, null, 2));
    const afterItem = await readItem(record.listingId);
    record.afterItem = afterItem;
    if (afterItem.price && afterItem.price !== record.price) record.error = `price changed ${record.price} -> ${afterItem.price}`;
    if (afterItem.title && afterItem.title !== record.title) record.error = `title changed`;
    if (afterItem.policy && record.policy && afterItem.policy !== record.policy) record.error = `policy changed ${record.policy} -> ${afterItem.policy}`;
    record.after = [];
    for (const zip of ZIPS) record.after.push(await quote(record.listingId, zip));
    if (record.error) {
      if (record.via === "inventory" && record.originalInventoryPackage) {
        const current = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/inventory_item/${encodeURIComponent(record.sku)}`);
        const body = { ...current, packageWeightAndSize: record.originalInventoryPackage };
        delete body.sku;
        await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(record.sku)}`, body);
      } else if (record.originalPackage) {
        await reviseFixedPricePackage(token, { itemId: record.listingId, ...record.originalPackage }, account);
      }
      record.appliedEbay = false;
      writeFileSync(path.join(DIR, "box-fix-backup.json"), JSON.stringify(backup, null, 2));
      console.log(JSON.stringify({ stopped: true, sku: record.sku, error: record.error }));
      break;
    }
  }
  const { error: updateError } = await sb
    .from("units")
    .update({
      package_length_in: next.lengthIn,
      package_width_in: next.widthIn,
      package_height_in: next.heightIn,
      package_weight_lb: next.weightLb,
    })
    .eq("store_id", STORE)
    .eq("sku", record.sku);
  if (updateError) {
    record.error = updateError.message;
    writeFileSync(path.join(DIR, "box-fix-backup.json"), JSON.stringify(backup, null, 2));
    console.log(JSON.stringify({ stopped: true, sku: record.sku, error: updateError.message }));
    break;
  }
  record.appliedFloor = true;
  writeFileSync(path.join(DIR, "box-fix-backup.json"), JSON.stringify(backup, null, 2));
  console.log(JSON.stringify({
    sku: record.sku,
    listingId: record.listingId,
    via: record.via || "floor-only",
    price: record.price,
    afterPrice: record.afterItem?.price || record.price,
    policy: record.afterItem?.policy || record.policy,
    from: record.originalPackage,
    readBack: record.afterItem?.box || null,
    before: record.before,
    after: record.after || null,
  }));
}
