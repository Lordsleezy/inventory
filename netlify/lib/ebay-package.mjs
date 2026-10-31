/** Package size sent to eBay. Rolled goods ship in a long thin box, not the flat product size. */

export const USPS_PRIORITY_GIRTH_IN = 108;
export const CARRIER_GIRTH_MAX_IN = 165;

const ROLLED = /\b(runners?|rugs?|curtains?|drap(?:e|es|ery)|panels?|wallpaper|blankets?|throws?|tapestries|cushions?)\b/i;

export function packageGirth(length, width, height) {
  const dims = [Number(length), Number(width), Number(height)].filter((n) => n > 0).sort((a, b) => b - a);
  if (dims.length < 3) return Infinity;
  return dims[0] + 2 * (dims[1] + dims[2]);
}

function roundIn(n) {
  return Math.max(1, Math.round(Number(n) * 10) / 10);
}

function estimateFromProduct(text) {
  const blob = String(text || "");
  const size = blob.match(/(\d+(?:\.\d+)?)\s*(?:["”″]|in(?:ch)?\.?)?\s*(?:x|×)\s*(\d+(?:\.\d+)?)/i);
  const a = size ? Number(size[1]) : 0;
  const b = size ? Number(size[2]) : 0;
  const longest = Math.max(a, b);
  if (/\b(card|pokemon|pokémon|trading)\b/i.test(blob)) {
    return { length: 6, width: 4, height: 1, weight: 0.25 };
  }
  if (ROLLED.test(blob)) {
    const length = longest >= 12 ? longest : /runner/i.test(blob) ? 60 : /curtain|panel/i.test(blob) ? 54 : 48;
    return { length, width: 5, height: 5, weight: /rug|runner/i.test(blob) ? 6 : 3 };
  }
  if (/\b(soap|gummies|vitamin|deodorant|bottle|candle)\b/i.test(blob)) {
    return { length: 8, width: 6, height: 4, weight: 1 };
  }
  return { length: 14, width: 10, height: 4, weight: 2 };
}

/**
 * Fit the package to a carrier. Rolled or folded goods that were measured flat
 * become a long thin box. Dims that still exceed every carrier are not returned
 * for sending — the caller must skip the push.
 */
export function shippablePackage(unit = {}) {
  const text = [unit.title, unit.brand, unit.model, unit.category].filter(Boolean).join(" ");
  const rolled = ROLLED.test(text);
  let length = Number(unit.package_length_in) || 0;
  let width = Number(unit.package_width_in) || 0;
  let height = Number(unit.package_height_in) || 0;
  let weight = Number(unit.package_weight_lb) || 0;
  let estimated = false;
  if (!(length > 0 && width > 0 && height > 0 && weight > 0)) {
    const guess = estimateFromProduct(text);
    length = length > 0 ? length : guess.length;
    width = width > 0 ? width : guess.width;
    height = height > 0 ? height : guess.height;
    weight = weight > 0 ? weight : guess.weight;
    estimated = true;
  }
  if (rolled && packageGirth(length, width, height) > USPS_PRIORITY_GIRTH_IN) {
    const longest = Math.max(length, width, height);
    let tube = 6;
    while (longest + 4 * tube > USPS_PRIORITY_GIRTH_IN - 3 && tube > 3) tube -= 1;
    length = longest;
    width = tube;
    height = tube;
    estimated = true;
  }
  length = roundIn(length);
  width = roundIn(width);
  height = roundIn(height);
  weight = Math.max(0.2, Math.round(weight * 100) / 100);
  const girth = packageGirth(length, width, height);
  if (girth > CARRIER_GIRTH_MAX_IN || Math.max(length, width, height) > 108) {
    return {
      ok: false,
      estimated,
      girth,
      reason: `Package length + girth ${Math.round(girth)} in is over the carrier limit. Not sent.`,
    };
  }
  const service = girth <= USPS_PRIORITY_GIRTH_IN ? "USPSPriority" : "UPSGround";
  return { ok: true, length, width, height, weight, estimated, girth, service };
}
