/**
 * Pure quarter + ledger math for the marketplace board.
 * Stats match portal_channel_report: gross is item + buyer shipping on non-voided
 * sales, fees and profit ignore voids, and label cost still counts when a voided
 * sale in the window has a label.
 */

const ZONE = "America/Los_Angeles";
const SPANS = ["Jan–Mar", "Apr–Jun", "Jul–Sep", "Oct–Dec"];

export function laMidnightIso(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  let t = Date.UTC(y, m - 1, d, 8);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(parts.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    t += Date.UTC(y, m - 1, d) - seen;
  }
  return new Date(t).toISOString();
}

export function quarterOf(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    year: "numeric",
    month: "numeric",
  }).formatToParts(date instanceof Date ? date : new Date(date));
  const year = Number(parts.find((p) => p.type === "year").value);
  const month = Number(parts.find((p) => p.type === "month").value);
  const q = Math.floor((month - 1) / 3) + 1;
  return {
    year,
    q,
    id: `${year}-Q${q}`,
    label: `Q${q} ${year} (${SPANS[q - 1]})`,
  };
}

export function currentQuarter(now = new Date()) {
  return quarterOf(now);
}

export function quarterBounds(id) {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(id || ""));
  if (!match) throw new Error("bad_quarter");
  const year = Number(match[1]);
  const q = Number(match[2]);
  const startMonth = (q - 1) * 3 + 1;
  const start = `${year}-${String(startMonth).padStart(2, "0")}-01`;
  const endMonthIndex = startMonth + 2;
  const endYear = endMonthIndex > 11 ? year + 1 : year;
  const endMonth = (endMonthIndex % 12) + 1;
  const end = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;
  const quarter = quarterOf(new Date(laMidnightIso(start)));
  return { id: quarter.id, year, q, start, end, from: laMidnightIso(start), to: laMidnightIso(end), label: quarter.label };
}

/** Current quarter plus every quarter that has a sale instant or an expense date. Newest first. */
export function collectQuarters(instants = [], dateOnly = [], now = new Date()) {
  const map = new Map();
  const add = (quarter) => map.set(quarter.id, quarter);
  add(currentQuarter(now));
  for (const iso of instants) {
    if (!iso) continue;
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) continue;
    add(quarterOf(when));
  }
  for (const ymd of dateOnly) {
    if (!ymd) continue;
    add(quarterOf(new Date(laMidnightIso(String(ymd).slice(0, 10)))));
  }
  return [...map.values()].sort((a, b) => b.year - a.year || b.q - a.q);
}

export function aggregateChannelStats(rows, { insertionCents = 0 } = {}) {
  let orders = 0;
  let gross = 0;
  let fees = 0;
  let ship = 0;
  let profit = 0;
  let voided = 0;
  let voidedShip = 0;
  for (const row of rows || []) {
    const isVoid = row.voided_at != null && row.voided_at !== "";
    const shipCost = Number(row.ship_cost_cents) || 0;
    if (!isVoid || shipCost > 0) ship += shipCost;
    if (isVoid) {
      voided += 1;
      // Same as portal_channel_report: voided sales drop out of gross/fees, but
      // labels already bought still reduce profit.
      if (shipCost > 0) voidedShip += shipCost;
      continue;
    }
    orders += 1;
    gross += (Number(row.price_cents) || 0) + (Number(row.shipping_cents) || 0);
    fees += Number(row.channel_fee_cents) || 0;
    profit += Number(row.profit_cents) || 0;
  }
  const feePct = gross > 0 ? Math.round((fees / gross) * 1000) / 10 : 0;
  return {
    orders,
    gross_cents: gross,
    fee_cents: fees,
    fee_pct: feePct,
    ship_cents: ship,
    profit_cents: profit - voidedShip,
    voided_count: voided,
    insertion_cents: Math.max(0, Math.round(Number(insertionCents) || 0)),
  };
}

export function shippingTag(mode) {
  return String(mode || "").toLowerCase() === "free" ? "free" : "buyer";
}

export function rowSearchText(row) {
  return [row?.sku, row?.title, row?.upc, row?.asin, row?.order_no, row?.receipt_no, row?.condition, row?.buyer_name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function buildNotListed(units, { liveSkus = [], photoBySku = {}, blockedBySku = {} } = {}) {
  const live = new Set(liveSkus.filter(Boolean));
  const out = [];
  for (const unit of units || []) {
    const sku = unit?.sku ? String(unit.sku) : "";
    if (!sku || live.has(sku)) continue;
    const blockedReason = blockedBySku[sku] || null;
    const photo = photoBySku[sku] || null;
    const priced = Number(unit.ask_cents) > 0;
    if (blockedReason) {
      out.push({
        sku,
        title: unit.title || `SKU ${sku}`,
        condition: unit.condition || null,
        upc: unit.upc || null,
        asin: unit.asin || null,
        price_cents: unit.ask_cents ?? null,
        photo_url: photo,
        blocked: true,
        blocked_reason: blockedReason,
      });
      continue;
    }
    if (!priced || !photo) continue;
    out.push({
      sku,
      title: unit.title || `SKU ${sku}`,
      condition: unit.condition || null,
      upc: unit.upc || null,
      asin: unit.asin || null,
      price_cents: unit.ask_cents ?? null,
      photo_url: photo,
      blocked: false,
      blocked_reason: null,
    });
  }
  return out;
}
