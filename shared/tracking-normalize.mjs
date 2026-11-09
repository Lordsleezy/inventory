import { uspsCheckDigitValid } from "./tracking-validate.mjs";

/** Normalize carrier barcodes for lookup (USPS 420+ZIP wrappers, whitespace). */
export function compactTracking(value) {
  let n = String(value || "").replace(/\s+/g, "").toUpperCase();
  const ups = n.match(/1Z[0-9A-Z]{16}/);
  if (ups) return ups[0];
  const wrapped5 = n.match(/^420\d{5}(9[2-5]\d{20,22})$/);
  if (wrapped5) return wrapped5[1];
  const wrapped9 = n.match(/^420\d{9}(9[2-5]\d{20,22})$/);
  if (wrapped9) return wrapped9[1];
  const embedded = [...n.matchAll(/9[2-5]\d{20,22}/g)].map((m) => m[0]);
  const checked = embedded.filter((hit) => uspsCheckDigitValid(hit));
  if (checked.length) return checked[checked.length - 1];
  if (embedded.length) return embedded[embedded.length - 1];
  if (/^\d{34}$/.test(n)) return n.slice(-12);
  return n;
}

export function trackingSuffix(value) {
  const c = compactTracking(value);
  return c.length >= 12 ? c.slice(-12) : c;
}
