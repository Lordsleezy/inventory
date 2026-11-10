import { compactTracking } from '../../../shared/tracking-normalize.mjs';
import { classifyCarrier } from '../../../shared/tracking-validate.mjs';

/** Light client hint before save — server still accepts manual entry. */
export function classifyCarrierHint(raw: string): { ok: boolean; carrier?: string } {
  const n = compactTracking(raw) || String(raw || '').replace(/\s+/g, '').toUpperCase();
  if (!n || n.length < 8) return { ok: false };
  const carrier = classifyCarrier(n);
  if (carrier) return { ok: true, carrier };
  if (/^1Z/i.test(n)) return { ok: false, carrier: 'UPS' };
  if (/^9[1-5]/.test(n.replace(/\D/g, ''))) return { ok: false, carrier: 'USPS' };
  if (n.replace(/\D/g, '').length >= 12) return { ok: false, carrier: 'FedEx' };
  return { ok: false };
}
