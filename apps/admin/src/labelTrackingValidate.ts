/** Light client hint before save — server still accepts manual entry. */
export function classifyCarrierHint(raw: string): { ok: boolean; carrier?: string } {
  const n = String(raw || '').replace(/\s+/g, '').toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(n)) return { ok: true, carrier: 'UPS' };
  const d = n.replace(/\D/g, '');
  if (/^9[2-5]\d{18,24}$/.test(d)) return { ok: true, carrier: 'USPS' };
  if (d.length >= 12) return { ok: false, carrier: 'USPS' };
  return { ok: false };
}
