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

/** Normalize carrier barcodes for lookup (USPS 420+ZIP wrappers, whitespace). */
export function compactTracking(value) {
  let n = String(value || "").replace(/\s+/g, "").toUpperCase();
  const ups = n.match(/1Z[0-9A-Z]{16}/);
  if (ups) return ups[0];

  const wrapped5 = n.match(/^420\d{5}(9[2-5]\d{20,22})$/);
  if (wrapped5 && uspsCheckDigitValid(wrapped5[1])) return wrapped5[1];
  const wrapped9 = n.match(/^420\d{9}(9[2-5]\d{20,22})$/);
  if (wrapped9 && uspsCheckDigitValid(wrapped9[1])) return wrapped9[1];

  if (/^9[2-5]\d{18,24}$/.test(n) && uspsCheckDigitValid(n)) return n;

  const fromSub = bestUspsSubstring(n);
  if (fromSub) return fromSub;

  const completed = completeUspsFromBody(n);
  if (completed) return completed;

  if (/^\d{34}$/.test(n)) return n.slice(-12);
  return n;
}

export function trackingSuffix(value) {
  const c = compactTracking(value);
  return c.length >= 12 ? c.slice(-12) : c;
}
