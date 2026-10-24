/** Channel → allowed label sources and carrier filters. */

export const LABEL_SOURCES = Object.freeze({
  shippo: "shippo",
  veeqo: "veeqo",
  tiktok: "tiktok",
  amazon: "amazon",
  ebay_logistics: "ebay_logistics",
});

/** Depop is intentionally excluded from one-click labels. */
export function channelAllowsLabels(channel) {
  const ch = String(channel || "website").toLowerCase();
  return ch === "website" || ch === "web" || ch === "ebay" || ch === "amazon" || ch === "tiktok";
}

/**
 * Which quote sources to ask for this channel.
 * Offline sources are still listed so the UI can show "Veeqo offline".
 */
export function sourcesForChannel(channel) {
  const ch = String(channel || "website").toLowerCase();
  if (ch === "website" || ch === "web") return [LABEL_SOURCES.shippo];
  if (ch === "ebay") return [LABEL_SOURCES.veeqo, LABEL_SOURCES.shippo, LABEL_SOURCES.ebay_logistics];
  if (ch === "amazon") return [LABEL_SOURCES.veeqo, LABEL_SOURCES.shippo, LABEL_SOURCES.amazon];
  if (ch === "tiktok") return [LABEL_SOURCES.tiktok, LABEL_SOURCES.veeqo, LABEL_SOURCES.shippo];
  return [];
}

/** True when this rate must not be bought for the channel (TikTok USPS outside TikTok Shipping). */
export function rateForbiddenForChannel(channel, rate) {
  const ch = String(channel || "").toLowerCase();
  if (ch !== "tiktok") return false;
  const carrier = String(rate?.carrier || "").toUpperCase();
  const isUsps = carrier.includes("USPS") || carrier === "US POSTAL SERVICE";
  if (!isUsps) return false;
  return rate?.source !== LABEL_SOURCES.tiktok;
}

/**
 * Pick cheapest valid rate. For Amazon, prefer Veeqo/Amazon Buy Shipping when within preferCents.
 */
export function pickCheapestRate(rates, { channel, preferAmazonWithinCents = 5 } = {}) {
  const usable = (rates || []).filter((r) => r && Number(r.amount_cents) > 0 && !rateForbiddenForChannel(channel, r));
  if (!usable.length) return null;
  const sorted = [...usable].sort(
    (a, b) => a.amount_cents - b.amount_cents || (a.days ?? 99) - (b.days ?? 99),
  );
  const cheapest = sorted[0];
  const ch = String(channel || "").toLowerCase();
  if (ch === "amazon" && preferAmazonWithinCents >= 0) {
    const protected_ = sorted.filter(
      (r) => r.protection === "amazon_buy_shipping" || r.source === LABEL_SOURCES.veeqo || r.source === LABEL_SOURCES.amazon,
    );
    const prefer = protected_.find((r) => r.amount_cents <= cheapest.amount_cents + preferAmazonWithinCents);
    if (prefer) {
      return {
        rate: prefer,
        reason:
          prefer.id === cheapest.id
            ? "Cheapest valid rate (Amazon Buy Shipping / Veeqo)"
            : `Within ${preferAmazonWithinCents}¢ of cheapest — preferred Amazon/Veeqo for claim protection`,
      };
    }
  }
  return { rate: cheapest, reason: "Cheapest valid rate across connected sources" };
}

export function encodeRateId(source, remoteId) {
  return `${source}:${remoteId}`;
}

export function decodeRateId(id) {
  const s = String(id || "");
  const i = s.indexOf(":");
  if (i <= 0) return { source: null, remoteId: s };
  return { source: s.slice(0, i), remoteId: s.slice(i + 1) };
}

export function isUspsCarrier(carrier) {
  const c = String(carrier || "").toUpperCase();
  return c.includes("USPS") || c === "US POSTAL SERVICE" || c === "UNITED STATES POSTAL SERVICE";
}
