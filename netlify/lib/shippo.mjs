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

/** Cheapest option, the cheapest per carrier, and the fastest that is not absurdly expensive. */
export function pickRates(rates, max = 4) {
  const norm = (rates || [])
    .filter(r => (r.currency || "USD") === "USD" && Number(r.amount) > 0 && r.object_id)
    .map(r => ({
      id: r.object_id,
      amount_cents: Math.round(Number(r.amount) * 100),
      carrier: r.provider,
      service: r.servicelevel?.name || r.servicelevel?.token || "Shipping",
      token: r.servicelevel?.token || null,
      days: Number.isFinite(Number(r.estimated_days)) ? Number(r.estimated_days) : null,
      source: "shippo",
    }))
    .sort((a, b) => a.amount_cents - b.amount_cents);
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

export async function liveRates({ shipFrom, to, pkg, fetchImpl }) {
  const shipment = await call("/shipments/", {
    method: "POST", fetchImpl,
    body: { address_from: shipFrom, address_to: to, parcels: [parcelFor(pkg)], async: false },
  });
  return {
    shipmentId: shipment.object_id,
    rates: pickRates(shipment.rates),
    allRates: shipment.rates || [],
    messages: (shipment.messages || []).map(m => m.text || String(m)).slice(0, 5),
  };
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
  const lb = Number(pkg?.weight_lb);
  if (!(lb > 0)) return null;
  const tier = (key, dflt) => { const n = Number(settings?.[key] ?? dflt); return n > 0 ? n : dflt; };
  const max = tier("ship_max_lb", 30);
  if (lb > max) return null;
  const cents = lb <= 5 ? tier("ship_tier_5_cents", 2000) : lb <= 15 ? tier("ship_tier_15_cents", 3200) : tier("ship_tier_30_cents", 5000);
  return { id: "fallback", amount_cents: cents, carrier: "Open Box Industries", service: "Standard shipping", token: null, days: null, source: "fallback" };
}
