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

/**
 * A 420 routing barcode is 420, then a 5- or 9-digit ZIP, then the tracking number.
 * Keep a split only when that ending number passes the USPS check digit.
 * If both ZIP lengths pass, prefer a normal 22- or 20-digit number.
 */
function uspsAfterRouting(digits) {
  if (!digits.startsWith("420")) return null;
  const hits = [];
  for (const zipLen of [5, 9]) {
    const rest = digits.slice(3 + zipLen);
    if (/^9[1-5]/.test(rest) && uspsCheckDigitValid(rest)) hits.push(rest);
  }
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0];
  const rank = (len) => {
    const i = [22, 20, 26, 30, 34].indexOf(len);
    return i === -1 ? 99 : i;
  };
  hits.sort((a, b) => rank(a.length) - rank(b.length) || b.length - a.length);
  return hits[0];
}

/** Normalize carrier barcodes for lookup (USPS 420+ZIP wrappers, UPS 1Z, FedEx 34-digit). */
export function compactTracking(value) {
  const n = String(value || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (!n) return "";
  const ups = n.match(/1Z[0-9A-Z]{16}/);
  if (ups) return ups[0];

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
