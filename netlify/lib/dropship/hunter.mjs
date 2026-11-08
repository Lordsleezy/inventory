/**
 * Dropship hunter: score catalog items into a ranked pick list.
 * Rules come from dropship_settings.settings (editable). Defaults match Paul's brief.
 */

const FRAGILE_RE = /\b(glass|porcelain|ceramic|fragile|mirror|vase)\b/i;
const PLUGGED_RE = /\b(plug(-|\s)?in|wall\s?charger|ac\s?adapter|power\s?cord|110v|120v|220v|electric\s?kettle|appliance)\b/i;
const KIDS_RE = /\b(kids?|toddler|infant|baby|children'?s|toy|teether)\b/i;
const COSMETIC_RE = /\b(cosmetic|makeup|lipstick|skincare|serum|lotion|cream|mascara|nail\s?polish)\b/i;
const CONSUMABLE_RE = /\b(consumable|supplement|vitamin|food|snack|candy|tea\s?bag|coffee\s?pod|ink\s?cartridge)\b/i;
const OVERSIZE_RE = /\b(furniture|mattress|sofa|treadmill|kayak|bicycle|bike\b|wardrobe)\b/i;

export const DEFAULT_HUNTER = {
  max_landed_pct_of_price: 38,
  min_retail_cents: 1500,
  min_profit_cents: 500,
  min_margin_bps: 4000,
  return_reserve_bps: 500,
  max_ships_in_days: 5,
  us_warehouse_only: true,
  stock_buffer: 3,
  exclusions: ["fragile", "plugged_in", "kids", "cosmetics", "consumables", "oversized", "branded"],
  brand_blocklist: [
    "apple", "sony", "samsung", "nike", "adidas", "dyson", "bose",
    "nintendo", "microsoft", "lg", "canon", "nikon", "gopro", "dyson",
  ],
  channel_fees: {
    ebay: { pct: 13.25, flat_cents: 30, promoted_pct: 0, verify: true },
    website: { pct: 2.9, flat_cents: 30, verify: true },
    tiktok: { pct: 8, flat_cents: 0, verify: true },
    amazon: { pct: 15, flat_cents: 0, verify: true, enabled: false },
  },
};

/**
 * Suggest a retail price that clears margin rules for a channel.
 * eBay fees are higher → eBay price will usually be higher than website.
 */
export function suggestPriceCents(landedCents, channel, settings = DEFAULT_HUNTER) {
  const fees = settings.channel_fees?.[channel] || DEFAULT_HUNTER.channel_fees[channel];
  if (!fees) return null;
  const reserveBps = Number(settings.return_reserve_bps ?? 500);
  const minProfit = Number(settings.min_profit_cents ?? 500);
  const minMarginBps = Number(settings.min_margin_bps ?? 4000);
  const maxLandedPct = Number(settings.max_landed_pct_of_price ?? 38) / 100;
  const minRetail = Number(settings.min_retail_cents ?? 1500);

  const feePct = (Number(fees.pct) || 0) / 100 + (Number(fees.promoted_pct) || 0) / 100;
  const flat = Number(fees.flat_cents) || 0;
  const reservePct = reserveBps / 10000;

  // price - feePct*price - flat - landed - reservePct*price >= max(minProfit, minMargin*price)
  // price * (1 - feePct - reservePct - minMargin) >= landed + flat + (minProfit if binding)
  // Iterate a few candidates.
  let price = Math.max(minRetail, Math.ceil(landedCents / Math.max(0.05, maxLandedPct)));
  for (let i = 0; i < 40; i++) {
    const fee = Math.round(price * feePct) + flat;
    const reserve = Math.round(price * reservePct);
    const profit = price - fee - landedCents - reserve;
    const marginBps = price > 0 ? Math.round((profit / price) * 10000) : 0;
    const landedOk = landedCents <= price * maxLandedPct + 0.5;
    if (profit >= minProfit && marginBps >= minMarginBps && landedOk && price >= minRetail) {
      return price;
    }
    price += 25; // +$0.25 steps
  }
  return null;
}

export function evaluateItem(item, channel, settings = DEFAULT_HUNTER) {
  const reasons = [];
  const excl = new Set(settings.exclusions || DEFAULT_HUNTER.exclusions);
  const title = String(item.title || "");
  const brand = String(item.brand || "").trim();

  if (settings.us_warehouse_only !== false && !item.ships_from_us && !item.shipsFromUs) {
    return skip("not US warehouse");
  }
  const stock = Number(item.stock_qty ?? item.stockQty ?? 0);
  const buffer = Number(settings.stock_buffer ?? 3);
  if (stock < buffer) return skip(`stock ${stock} below buffer ${buffer}`);

  const shipsIn = Number(item.processing_days ?? item.processingDays ?? item.ships_in_days ?? 99);
  if (shipsIn > Number(settings.max_ships_in_days ?? 5)) {
    return skip(`ships in ${shipsIn}d > max`);
  }

  if (excl.has("fragile") && FRAGILE_RE.test(title)) return skip("fragile");
  if (excl.has("plugged_in") && PLUGGED_RE.test(title)) return skip("plugged-in / wall power");
  if (excl.has("kids") && KIDS_RE.test(title)) return skip("kids product");
  if (excl.has("cosmetics") && COSMETIC_RE.test(title)) return skip("cosmetics");
  if (excl.has("consumables") && CONSUMABLE_RE.test(title)) return skip("consumable");
  if (excl.has("oversized") && OVERSIZE_RE.test(title)) return skip("oversized");

  if (excl.has("branded")) {
    const block = (settings.brand_blocklist || DEFAULT_HUNTER.brand_blocklist).map((b) => b.toLowerCase());
    const hay = `${brand} ${title}`.toLowerCase();
    for (const b of block) {
      if (!b) continue;
      // word-ish match; when in doubt, skip
      const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(b)}(?:[^a-z0-9]|$)`, "i");
      if (re.test(hay)) return skip(`branded (${b})`);
    }
    // Unknown explicit brand that looks like a trademarked name → skip when brand field set to something non-generic
    if (brand && !/^(generic|unbranded|no brand|oem|n\/a)$/i.test(brand) && brand.length > 2) {
      // still allow empty; if brand is present and not in allow-ish list, skip for safety
      if (!/^(open box|everyday|basic|home|pro|plus)$/i.test(brand)) {
        return skip(`branded field "${brand}" — when in doubt, skip`);
      }
    }
  }

  const cost = Number(item.cost_cents ?? item.costCents ?? 0);
  const ship = Number(item.shipping_cents ?? item.shippingCents ?? 0);
  const landed = Number(item.landed_cents ?? cost + ship);
  if (landed <= 0) return skip("missing cost");

  const price = suggestPriceCents(landed, channel, settings);
  if (price == null) return skip("cannot clear margin at any reasonable price");

  const fees = settings.channel_fees?.[channel] || DEFAULT_HUNTER.channel_fees[channel];
  const feePct = (Number(fees.pct) || 0) / 100 + (Number(fees.promoted_pct) || 0) / 100;
  const feeCents = Math.round(price * feePct) + (Number(fees.flat_cents) || 0);
  const reserveCents = Math.round(price * (Number(settings.return_reserve_bps ?? 500) / 10000));
  const profit = price - feeCents - landed - reserveCents;
  const marginBps = Math.round((profit / price) * 10000);

  reasons.push(
    `Landed $${(landed / 100).toFixed(2)} → ask $${(price / 100).toFixed(2)} on ${channel}`,
    `Est. profit $${(profit / 100).toFixed(2)} (${(marginBps / 100).toFixed(1)}%) after fees + ${(Number(settings.return_reserve_bps) / 100).toFixed(0)}% reserve`,
    `US warehouse, ships ~${shipsIn}d, stock ${stock}`,
  );

  return {
    ok: true,
    channel,
    suggested_price_cents: price,
    landed_cents: landed,
    fee_cents: feeCents,
    reserve_cents: reserveCents,
    profit_cents: profit,
    margin_bps: marginBps,
    ships_in_days: shipsIn,
    reason: reasons.join(". "),
    rank_score: profit + marginBps / 100, // prefer dollars then margin
  };
}

function skip(reason) {
  return { ok: false, reason };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Run hunter over a list; return ranked ok picks. */
export function hunt(items, channels = ["ebay"], settings = DEFAULT_HUNTER) {
  const out = [];
  for (const item of items) {
    for (const channel of channels) {
      if (channel === "amazon" && settings.channel_fees?.amazon?.enabled === false) continue;
      if (channel === "tiktok" && settings.tiktok_channel_on === false) continue;
      const ev = evaluateItem(item, channel, settings);
      if (ev.ok) out.push({ item, ...ev });
    }
  }
  out.sort((a, b) => b.rank_score - a.rank_score);
  return out;
}
