/** eBay price, shipping mode, and payout-fee math. Pure: no network. */
import { aspectAllowsCustom } from "./ebay-aspects.mjs";

export function roundUpEnding(cents, ending = 99) {
  const amount = Math.max(0, Number(cents) || 0);
  const end = Math.min(99, Math.max(0, Math.round(Number(ending) || 0)));
  const dollars = Math.floor(amount / 100);
  let candidate = dollars * 100 + end;
  if (candidate + 1e-9 < amount) candidate = (dollars + 1) * 100 + end;
  return candidate;
}

export function shippingModeForLabel(labelCents, cutoffCents) {
  if (!(Number(labelCents) >= 0)) return null;
  return Number(labelCents) <= Number(cutoffCents) ? "free" : "calculated";
}

/**
 * Free shipping: (floor + label + buffer) / (1 - fee) + per-order fee, then round up to the ending.
 * Calculated: floor / (1 - fee) + per-order fee, same rounding. Label is not in the price.
 */
export function priceQuotes(floorCents, labelCents, settings) {
  if (labelCents == null || !(Number(labelCents) >= 0) || !(Number(floorCents) > 0)) return null;
  const common = {
    floorCents,
    labelCents,
    bufferCents: settings.bufferCents,
    feePct: settings.feePct,
    perOrderCents: settings.perOrderCents,
    ending: settings.ending,
  };
  return {
    free: ebayPriceCents({ ...common, mode: "free" }),
    calculated: ebayPriceCents({ ...common, mode: "calculated" }),
  };
}

export function ebayPriceCents({ floorCents, labelCents = 0, bufferCents = 0, mode, feePct, perOrderCents = 0, ending = 99 }) {
  const fee = Number(feePct) / 100;
  if (!(fee >= 0 && fee < 1)) throw new Error("eBay fee percent must be between 0 and 100.");
  const floor = Math.max(0, Math.round(Number(floorCents) || 0));
  const label = Math.max(0, Math.round(Number(labelCents) || 0));
  const buffer = Math.max(0, Math.round(Number(bufferCents) || 0));
  const base = mode === "free" ? floor + label + buffer : floor;
  const raw = base / (1 - fee) + Math.max(0, Number(perOrderCents) || 0);
  return roundUpEnding(raw, ending);
}

export function ebayFeeCents(itemCents, feePct, perOrderCents = 0) {
  const item = Math.max(0, Math.round(Number(itemCents) || 0));
  return Math.round(item * (Number(feePct) / 100)) + Math.max(0, Math.round(Number(perOrderCents) || 0));
}

function toCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Item price for the Floor sale. Buyer-paid shipping stays out of the item price. */
export function ebayOrderAmounts(order) {
  const line = order?.lineItems?.[0] || {};
  const item =
    line.lineItemCost?.value ??
    order?.pricingSummary?.priceSubtotal?.value ??
    line.total?.value ??
    order?.pricingSummary?.total?.value;
  const ship = order?.pricingSummary?.deliveryCost?.value ?? 0;
  return { itemCents: toCents(item), shipCents: toCents(ship) };
}

export function ebayShipTo(order) {
  const step = order?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
  const buyer = order?.buyer?.buyerRegistrationAddress;
  const who = step || buyer || {};
  const addr = who.contactAddress || who;
  return {
    name: who.fullName || who.name || order?.buyer?.username || "",
    email: who.email || order?.buyer?.email || "",
    phone: who.primaryPhone?.phoneNumber || who.phone || "",
    line1: addr.addressLine1 || "",
    line2: addr.addressLine2 || "",
    city: addr.city || "",
    region: addr.stateOrProvince || "",
    postal: addr.postalCode || "",
  };
}

/** East-coast quote address for a ZIP. City is only so Shippo will rate the ZIP. */
export function farZoneAddress(zip) {
  const z = String(zip || "10001").replace(/\D/g, "").slice(0, 5).padStart(5, "0");
  const places = [
    [/^02/, "Boston", "MA"],
    [/^19/, "Philadelphia", "PA"],
    [/^20/, "Washington", "DC"],
    [/^30/, "Atlanta", "GA"],
    [/^33/, "Miami", "FL"],
  ];
  const hit = places.find(([re]) => re.test(z));
  const city = hit ? hit[1] : "New York";
  const region = hit ? hit[2] : "NY";
  return { name: "Rate quote", line1: "100 Main St", city, region, postal: z, phone: "2125550100", email: "" };
}

/** Weight/dim estimate when Shippo is down. Used only to choose free vs calculated and to bake a label. */
export function fallbackLabelCents(pkg) {
  const lb = Number(pkg?.weight_lb);
  const l = Number(pkg?.length_in);
  const w = Number(pkg?.width_in);
  const h = Number(pkg?.height_in);
  if (!(lb > 0) || !(l > 0) || !(w > 0) || !(h > 0)) return null;
  const dim = (l * w * h) / 139;
  const billed = Math.max(lb, dim);
  if (billed <= 1) return 900;
  if (billed <= 3) return 1200;
  if (billed <= 5) return 1500;
  if (billed <= 10) return 2200;
  if (billed <= 20) return 3500;
  if (billed <= 40) return 5500;
  return 8000;
}

import { ebayIdentifiers } from "./ebay-product.mjs";

export function draftReadiness(draft) {
  const items = [];
  const need = (ok, label) => items.push({ ok: Boolean(ok), label });
  const photos = Array.isArray(draft?.photo_paths) ? draft.photo_paths.filter(Boolean) : [];
  const box = draft?.box || {};
  const boxOk = [box.length_in, box.width_in, box.height_in, box.weight_lb].every((n) => Number(n) > 0);
  need(photos.length > 0, "At least one photo");
  const title = String(draft?.title || "");
  need(title.trim().length > 0 && title.length <= 80, "Title, 80 characters or less");
  need(String(draft?.description || "").trim(), "Description");
  need(draft?.category_id, "eBay category");
  need(draft?.condition_not_supported || draft?.condition_id, draft?.condition_not_supported ? "This category does not use a condition field" : "Condition this category allows");
  need(boxOk, boxOk ? "Box size and weight" : "Needs box size");
  need(Number(draft?.price_cents) > 0, "eBay price");
  need(draft?.shipping_mode === "free" || draft?.shipping_mode === "calculated", "Shipping mode");
  const identifiers = ebayIdentifiers({ brand: draft?.unit_brand, model: draft?.unit_model, upc: draft?.unit_upc }, draft?.aspects);
  need(identifiers.validBrand, "Brand needed");
  need(Boolean(identifiers.mpn), "MPN or Does not apply");
  need(!identifiers.upcIssue, identifiers.upcIssue
    ? `UPC from the scan looks wrong (${identifiers.upcIssue}); check the barcode or leave blank`
    : "UPC valid or blank");
  const defs = Array.isArray(draft?.aspect_defs) ? draft.aspect_defs : [];
  if (!draft?.category_id) need(false, "eBay item specifics");
  else if (!defs.length) need(false, "eBay item specifics loaded");
  else {
    const aspects = draft?.aspects || {};
    for (const def of defs.filter((d) => d.required)) {
      const identifier = { brand: identifiers.brand, mpn: identifiers.mpn, upc: identifiers.upc || "Does not apply" }[String(def.name).toLowerCase()];
      const value = String(aspects[def.name] || identifier || "").trim();
      const allowed = Array.isArray(def.allowed) ? def.allowed : [];
      const known = aspectAllowsCustom(def) || !allowed.length || allowed.includes(value);
      need(value && known, `Required: ${def.name}`);
    }
  }
  return { ready: items.every((item) => item.ok), items };
}
