import { uspsCheckDigitValid } from "./tracking-validate.mjs";
import { completeUspsFromBody } from "./tracking-validate.mjs";

function bestUspsSubstring(n) {
  const hits = [];
  for (const m of n.matchAll(/9[2-5]\d{18,24}/g)) {
    if (uspsCheckDigitValid(m[0])) hits.push(m[0]);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.length - a.length || n.lastIndexOf(b) - n.lastIndexOf(a));
  return hits[0];
}

function preferUspsLength(hits) {
  if (hits.length === 1) return hits[0];
  const rank = (len) => {
    const i = [22, 20, 26, 30, 34].indexOf(len);
    return i === -1 ? 99 : i;
  };
  hits.sort((a, b) => rank(a.length) - rank(b.length) || b.length - a.length);
  return hits[0];
}

/**
 * `(420)` is the ZIP. `(94)` and the digits after it are the tracking number.
 * The 94 is part of the number stored on the order.
 */
function uspsFromGs1(value) {
  const marked = String(value || "").match(/\(9([1-5])\)(\d{18,32})/);
  if (!marked) return null;
  const number = `9${marked[1]}${marked[2]}`;
  return /^9[1-5]\d{19,33}$/.test(number) ? number : null;
}

/**
 * A 420 routing barcode is 420, then a 5-, 9-, or 11-digit ZIP, then the tracking number.
 * A valid check digit wins. A normal-length 91–95 number still counts when the digit does not,
 * so the scan is not chopped down to a FedEx last-12.
 */
function uspsAfterRouting(digits) {
  if (!digits.startsWith("420")) return null;
  const valid = [];
  const shaped = [];
  for (const zipLen of [5, 9, 11]) {
    const rest = digits.slice(3 + zipLen);
    if (!/^9[1-5]\d{17,32}$/.test(rest)) continue;
    if (uspsCheckDigitValid(rest)) valid.push(rest);
    else shaped.push(rest);
  }
  if (valid.length) return preferUspsLength(valid);
  if (shaped.length) return preferUspsLength(shaped);
  return null;
}

/** Normalize carrier barcodes for lookup (USPS 420+ZIP wrappers, UPS 1Z, FedEx 34-digit). */
export function compactTracking(value) {
  const n = String(value || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (!n) return "";
  const ups = n.match(/1Z[0-9A-Z]{16}/);
  if (ups) return ups[0];

  const gs1 = uspsFromGs1(value);
  if (gs1) return gs1;

  const digits = n.replace(/[A-Z]/g, "");
  const routed = uspsAfterRouting(digits);
  if (routed) return routed;

  if (/^9[1-5]\d{17,32}$/.test(digits) && uspsCheckDigitValid(digits)) return digits;

  const fromSub = bestUspsSubstring(digits);
  if (fromSub) return fromSub;

  const completed = completeUspsFromBody(digits);
  if (completed) return completed;

  if (/^\d{34}$/.test(digits)) return digits.slice(-12);
  return n;
}

export function trackingSuffix(value) {
  const c = compactTracking(value);
  return c.length >= 12 ? c.slice(-12) : c;
}
