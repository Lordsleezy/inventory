/**
 * What a buyer should pay for shipping, from real labels at zone 6.
 * Dimensional weight applies once a box is over one cubic foot.
 * The $6 floor is the cheapest label we actually buy.
 * eBay's fee is taken out of shipping, so the buyer price is grossed up.
 * A listing is changed only when eBay's package would charge more and the
 * real package would charge less. A low price is never raised.
 */

export const LABEL_FLOOR_CENTS = 600;
export const FINE_BAND_CENTS = 150;
export const EBAY_SHIP_FEE = 0.1325;
const DIM_DIVISOR = 166;
const DIM_CUBIC_IN = 1728;

export function billedPounds(pkg) {
  const actual = Math.max(0, Number(pkg?.weight_lb) || 0);
  const cubic = Math.max(0, Number(pkg?.length_in) || 0)
    * Math.max(0, Number(pkg?.width_in) || 0)
    * Math.max(0, Number(pkg?.height_in) || 0);
  const dim = cubic > DIM_CUBIC_IN ? cubic / DIM_DIVISOR : 0;
  return Math.round(Math.max(actual, dim) * 100) / 100;
}

/** Zone-6 label cost from past shipments, before the fee and before the floor. */
export function zone6LabelCents(pounds) {
  const n = Math.max(0, Number(pounds) || 0);
  if (n <= 1) return 650;
  if (n <= 5) return 880;
  if (n <= 15) return 1400;
  if (n <= 30) return 2400;
  if (n <= 50) return 3500;
  return 4500;
}

export function buyerShipCents(labelCents) {
  const cost = Math.max(LABEL_FLOOR_CENTS, Math.round(Number(labelCents) || 0));
  return Math.round(cost / (1 - EBAY_SHIP_FEE));
}

export function shouldBeShipCents(pkg, sameModelLabelCents = null) {
  if (!pkg || !(Number(pkg.weight_lb) > 0)) return null;
  if (Number(sameModelLabelCents) > 0) return buyerShipCents(sameModelLabelCents);
  return buyerShipCents(zone6LabelCents(billedPounds(pkg)));
}

export function classifyShip(ebayCents, shouldCents) {
  if (!(Number(ebayCents) > 0) || !(Number(shouldCents) > 0)) return "unknown";
  const diff = Math.round(ebayCents) - Math.round(shouldCents);
  if (Math.abs(diff) <= FINE_BAND_CENTS) return "fine";
  return diff > 0 ? "too_high" : "too_low";
}

function close(a, b, slop) {
  return Math.abs(Number(a) - Number(b)) <= slop;
}

export function packagesMatch(ebay, floor) {
  if (!ebay || !floor) return false;
  const ebayLb = Number(ebay.weight_lb) || (Number(ebay.lb) + Number(ebay.oz || 0) / 16);
  return close(ebayLb, floor.weight_lb, 0.25)
    && close(ebay.length_in ?? ebay.length, floor.length_in, 0.5)
    && close(ebay.width_in ?? ebay.width, floor.width_in, 0.5)
    && close(ebay.height_in ?? ebay.height, floor.height_in, 0.5);
}

/** Never write a package that would raise the buyer price, and never write when eBay already has the real package. */
export function packageWrite(ebayPkg, floorPkg, ebayCents) {
  const should = shouldBeShipCents(floorPkg);
  const kind = classifyShip(ebayCents, should);
  if (kind !== "too_high") return { write: false, reason: kind || "unknown", should_cents: should };
  if (!floorPkg || !(floorPkg.weight_lb >= 0.2)) return { write: false, reason: "weight_unusable", should_cents: should };
  if (packagesMatch(ebayPkg, floorPkg)) return { write: false, reason: "already_matches", should_cents: should };
  if (billedPounds(floorPkg) > billedPounds(ebayPkg) + 0.25) {
    return { write: false, reason: "would_raise", should_cents: should };
  }
  return { write: true, reason: "too_high", should_cents: should, package: floorPkg };
}
