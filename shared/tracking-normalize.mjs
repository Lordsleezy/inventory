/** Normalize carrier barcodes for lookup (USPS 420+ZIP wrappers, whitespace). */
export function compactTracking(value) {
  let n = String(value || "").replace(/\s+/g, "").toUpperCase();
  const wrapped = n.match(/^420\d{5}(9[2-5]\d{18,24})$/) || n.match(/^420\d{9}(9[2-5]\d{18,24})$/);
  if (wrapped) n = wrapped[1];
  const ups = n.match(/1Z[0-9A-Z]{16}/);
  if (ups) return ups[0];
  if (/^\d{34}$/.test(n)) return n.slice(-12);
  return n;
}

export function trackingSuffix(value) {
  const c = compactTracking(value);
  return c.length >= 12 ? c.slice(-12) : c;
}
