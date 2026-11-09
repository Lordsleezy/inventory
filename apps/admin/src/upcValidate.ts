/** Shared UPC/EAN checks for Receive, Edit, and the item-page inline Add UPC flow. */

export const UPC_NOT_APPLICABLE = 'Does not apply';

export function digitsOnly(value: string) {
  return String(value ?? '').replace(/\D/g, '');
}

function checkDigit(body: string) {
  let sum = 0;
  for (let i = body.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(body[i]) * weight;
  }
  return String((10 - (sum % 10)) % 10);
}

export function gtinIssue(value: string): string | null {
  const code = String(value ?? '').trim();
  if (!code) return null;
  if (!/^\d+$/.test(code)) return 'digits only';
  if (![12, 13, 14].includes(code.length)) return 'must have 12, 13, or 14 digits';
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(code[i]) * weight;
  }
  return Number(code.at(-1)) === (10 - (sum % 10)) % 10 ? null : 'bad check digit';
}

/** Expand UPC-E (6–8 digits) to UPC-A when possible. */
export function expandUpcE(raw: string): string | null {
  let d = digitsOnly(raw);
  let ns = '0';
  if (d.length === 8) {
    ns = d[0];
    d = d.slice(1, 7);
  } else if (d.length === 7) {
    d = d.slice(0, 6);
  }
  if (d.length !== 6) return null;
  const [n2, n3, n4, n5, n6, n7] = d.split('');
  let mid: string;
  if ('012'.includes(n7)) mid = `${n2}${n3}${n7}0000${n4}${n5}${n6}`;
  else if (n7 === '3') mid = `${n2}${n3}${n4}00000${n5}${n6}`;
  else if (n7 === '4') mid = `${n2}${n3}${n4}${n5}00000${n6}`;
  else mid = `${n2}${n3}${n4}${n5}${n6}0000${n7}`;
  const body = `${ns}${mid}`;
  if (body.length !== 11) return null;
  return body + checkDigit(body);
}

export type NormalizedUpc = {
  ok: boolean;
  input: string;
  upcA: string | null;
  ean13: string | null;
  gtin14: string | null;
  issue: string | null;
};

export function normalizeUpc(raw: string): NormalizedUpc {
  const input = String(raw ?? '').trim();
  let d = digitsOnly(input);
  if (!d) return { ok: false, input, upcA: null, ean13: null, gtin14: null, issue: 'empty' };

  if (d.length === 6 || d.length === 7 || (d.length === 8 && d[0] === '0')) {
    const upcA = expandUpcE(d);
    if (!upcA) return { ok: false, input, upcA: null, ean13: null, gtin14: null, issue: 'bad upc-e' };
    d = upcA;
  }

  if (d.length === 11) d = `0${d}`;
  if (d.length === 12 || d.length === 13 || d.length === 14) {
    const issue = gtinIssue(d);
    if (issue) return { ok: false, input, upcA: null, ean13: null, gtin14: null, issue };
    const gtin14 = d.padStart(14, '0');
    return { ok: true, input, upcA: gtin14.slice(2), ean13: gtin14.slice(1), gtin14, issue: null };
  }
  return { ok: false, input, upcA: null, ean13: null, gtin14: null, issue: `unsupported length ${d.length}` };
}

export function upcValidationMessage(raw: string): string | null {
  const n = normalizeUpc(raw);
  if (n.ok) return null;
  if (n.issue === 'empty') return 'Enter a UPC or mark No UPC.';
  if (n.issue === 'bad check digit') return 'That barcode fails the check digit. Scan again or fix a typo.';
  if (n.issue?.startsWith('unsupported length')) return 'UPC/EAN must be 8–14 digits.';
  if (n.issue === 'digits only') return 'UPC/EAN can only contain digits.';
  return 'That does not look like a valid UPC/EAN.';
}

export function isUpcDoesNotApply(value: unknown, specs?: Record<string, unknown> | null) {
  const direct = String(value || '').trim();
  if (/^(does not apply|n\/?a)$/i.test(direct)) return true;
  if (specs && typeof specs === 'object') {
    const fromSpecs = String(specs.upc || '').trim();
    if (/^(does not apply|n\/?a)$/i.test(fromSpecs)) return true;
  }
  return false;
}

export function upcVariants(upc: string, extra?: { upcA?: string | null; ean13?: string | null; gtin14?: string | null }) {
  return [...new Set([upc, extra?.upcA, extra?.ean13, extra?.gtin14].map((v) => String(v || '').trim()).filter(Boolean))];
}

export function hasUpcValue(unit: { upc?: unknown; upc_does_not_apply?: unknown; listing_specs?: unknown }) {
  if (unit.upc_does_not_apply === true) return true;
  if (String(unit.upc || '').trim()) return true;
  const specs = unit.listing_specs && typeof unit.listing_specs === 'object'
    ? unit.listing_specs as Record<string, unknown>
    : null;
  return isUpcDoesNotApply('', specs);
}
