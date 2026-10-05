/** Shippo live carrier rates and label purchase. The API key is read from env only. */
const API = "https://api.goshippo.com";

export function shippoMode() {
  const key = process.env.SHIPPO_API_KEY || "";
  if (key.startsWith("shippo_live_")) return "live";
  if (key.startsWith("shippo_test_")) return "test";
  return null;
}

async function call(path, { method = "GET", body, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const key = process.env.SHIPPO_API_KEY;
  if (!key) throw new Error("missing_SHIPPO_API_KEY");
  const res = await fetchImpl(API + path, {
    method,
    headers: { Authorization: `ShippoToken ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { detail: text.slice(0, 300) }; }
  if (!res.ok) {
    const err = new Error(`shippo_${res.status}`);
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

export function parcelFor(pkg) {
  return {
    length: String(pkg.length_in), width: String(pkg.width_in), height: String(pkg.height_in),
    distance_unit: "in", weight: String(pkg.weight_lb), mass_unit: "lb",
  };
}

export function addressTo(o) {
  return {
    name: o.name, street1: o.line1, street2: o.line2 || "", city: o.city, state: o.region,
    zip: o.postal, country: "US", phone: o.phone || "", email: o.email || "",
  };
}

export function normalizeRates(rates) {
  return (rates || [])
    .filter(r => (r.currency || "USD") === "USD" && Number(r.amount) > 0 && r.object_id)
    .map(r => ({
      id: r.object_id,
      amount_cents: Math.round(Number(r.amount) * 100),
      carrier: r.provider,
      service: r.servicelevel?.name || r.servicelevel?.token || "Shipping",
      token: r.servicelevel?.token || null,
      days: r.estimated_days != null && Number.isFinite(Number(r.estimated_days)) ? Number(r.estimated_days) : null,
      source: "shippo",
    }))
    .sort((a, b) => a.amount_cents - b.amount_cents || (a.days ?? 99) - (b.days ?? 99));
}

/**
 * Packing-time default: the cheapest rate that is as fast as or faster than the service the customer
 * paid for. If none is that fast, the fastest available. Without a delivery estimate to compare
 * against (flat-rate fallback orders), the cheapest.
 */
export function pickDefaultRate(rates, paid) {
  const sorted = [...(rates || [])].sort((a, b) => a.amount_cents - b.amount_cents || (a.days ?? 99) - (b.days ?? 99));
  if (!sorted.length) return null;
  const paidDays = Number(paid?.days);
  if (Number.isFinite(paidDays) && paidDays > 0) {
    const asFast = sorted.filter(r => r.days != null && r.days <= paidDays);
    if (asFast.length) return { rate: asFast[0], reason: `Cheapest option delivering in ${paidDays} day${paidDays === 1 ? "" : "s"} or less (what the customer paid for)` };
    const fastest = sorted.filter(r => r.days != null).sort((a, b) => a.days - b.days || a.amount_cents - b.amount_cents)[0];
    if (fastest) return { rate: fastest, reason: "Nothing is as fast as what the customer paid for; this is the fastest available" };
  }
  return { rate: sorted[0], reason: "Cheapest option (no delivery estimate to match)" };
}

/** Cheapest option, the cheapest per carrier, and the fastest that is not absurdly expensive. */
export function pickRates(rates, max = 4) {
  const norm = normalizeRates(rates);
  if (!norm.length) return [];
  const picked = [];
  const add = r => { if (r && !picked.some(p => p.id === r.id)) picked.push(r); };
  add(norm[0]);
  for (const carrier of [...new Set(norm.map(r => r.carrier))]) add(norm.find(r => r.carrier === carrier));
  const ceiling = norm[0].amount_cents * 2.5;
  const fastest = norm.filter(r => r.days != null && r.amount_cents <= ceiling).sort((a, b) => a.days - b.days || a.amount_cents - b.amount_cents)[0];
  add(fastest);
  return picked.slice(0, max).sort((a, b) => a.amount_cents - b.amount_cents);
}

/** Carriers activated in Shippo that we are willing to offer/buy (store setting ship_carriers, default USPS). */
export async function allowedCarriers(sb, storeId) {
  const { data } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", "ship_carriers").maybeSingle();
  const list = Array.isArray(data?.value) ? data.value.map(x => String(x).trim().toUpperCase()).filter(Boolean) : [];
  return list.length ? list : ["USPS"];
}

export async function liveRates({ shipFrom, to, pkg, fetchImpl, carriers }) {
  const shipment = await call("/shipments/", {
    method: "POST", fetchImpl,
    body: { address_from: shipFrom, address_to: to, parcels: [parcelFor(pkg)], async: false },
  });
  const usable = carriers?.length ? (shipment.rates || []).filter(r => carriers.includes(String(r.provider).trim().toUpperCase())) : (shipment.rates || []);
  return {
    shipmentId: shipment.object_id,
    rates: pickRates(usable),
    all: normalizeRates(usable).slice(0, 15),
    allRates: usable,
    messages: (shipment.messages || []).map(m => m.text || String(m)).slice(0, 5),
  };
}

export async function getRate(rateId, { fetchImpl } = {}) {
  const r = await call(`/rates/${encodeURIComponent(rateId)}`, { fetchImpl });
  const [norm] = normalizeRates([r]);
  if (!norm) throw new Error("rate_not_usable");
  return norm;
}

export async function buyLabel(rateId, { fetchImpl } = {}) {
  return call("/transactions/", { method: "POST", fetchImpl, body: { rate: rateId, label_file_type: "PDF_4x6", async: false } });
}

export async function refundLabel(transactionId, { fetchImpl } = {}) {
  return call("/refunds/", { method: "POST", fetchImpl, body: { transaction: transactionId, async: false } });
}

/** Flat weight tiers, only when Shippo is unreachable. Never returns $0. */
export function fallbackRate(settings, pkg, overrideCents) {
  if (Number(overrideCents) > 0) {
    return { id: "fallback", amount_cents: Number(overrideCents), carrier: "Open Box Industries", service: "Standard shipping", token: null, days: null, source: "fallback" };
  }
  const actual = Number(pkg?.weight_lb), dims = [Number(pkg?.length_in), Number(pkg?.width_in), Number(pkg?.height_in)];
  if (!(actual > 0) || dims.some(n => !(n > 0))) return null;
  const roundedVolume = dims.reduce((n, d) => n * Math.ceil(d), 1);
  const dimWeight = roundedVolume > 1728 ? Math.ceil(roundedVolume / 139) : 0;
  const billable = Math.max(Math.ceil(actual), dimWeight, 1);
  const tiers = Array.isArray(settings?.manual_shipping_tiers) ? settings.manual_shipping_tiers : [];
  const tier = tiers.find(t => Number(t.max_lb) >= billable);
  if (!tier || billable > 70) return null;
  const longest = Math.max(...dims), lengthGirth = longest + 2 * (dims.reduce((a,b) => a+b,0) - longest);
  if (lengthGirth > 130) return null;
  // USPS Notice 123, zone 8. Add current Ground Advantage nonstandard charges.
  let cents = Number(tier.cents);
  if (!Number.isFinite(cents) || cents <= 0) return null;
  if (lengthGirth > 108) cents = Number(settings?.manual_oversize_cents || 30175);
  else {
    if (longest > 30) cents += 1000;
    else if (longest > 22) cents += 450;
    if (roundedVolume > 3456) cents += 2100;
  }
  const billableLabel = dimWeight > Math.ceil(actual) ? ` (dimensional weight ${dimWeight} lb)` : "";
  return { id: "manual_usps_zone8", amount_cents: cents, carrier: "USPS", service: `Ground Advantage · up to ${Number(tier.max_lb)} lb${billableLabel}`, token: null, days: null, source: "manual" };
}
