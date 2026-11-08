/** Normalize carrier barcodes for lookup (USPS 420+ZIP wrappers, whitespace). */
export function compactTracking(value) {
  const n = String(value || "").replace(/\s+/g, "").toUpperCase();
  const wrapped = n.match(/^420\d{5}(9[2-5]\d{18,24})$/) || n.match(/^420\d{9}(9[2-5]\d{18,24})$/);
  return wrapped ? wrapped[1] : n;
}

export function trackingSuffix(value) {
  const c = compactTracking(value);
  return c.length >= 12 ? c.slice(-12) : c;
}
