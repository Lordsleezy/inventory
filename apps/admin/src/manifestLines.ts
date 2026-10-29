import { parseManifestCsv } from './manifestCount.ts';

export type ManifestLine = {
  line_number: number; upc_raw: string; upc_normalized: string; tcin: string;
  description: string; brand: string; qty: number; unit_retail_cents: number;
  condition: string; pallet_id: string; lot_id: string;
};

/** Preserve the UPC-A zero; remove only the EAN/GTIN wrapper zeros. Target 49 codes are UPCs too. */
export function normalizeManifestUpc(raw: string): string {
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d{8,14}$/.test(digits)) return '';
  if (digits.length === 14 && digits.startsWith('00')) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

export function parseManifestLines(source: string): ManifestLine[] {
  const rows = parseManifestCsv(source.replace(/^\uFEFF/, '')).filter(row => row.some(cell => cell.trim()));
  const headers = (rows.shift() || []).map(cell => cell.trim().toLowerCase());
  const required = ['UPC', 'Qty', 'Unit Retail', 'Condition'];
  const missing = required.filter(name => !headers.includes(name.toLowerCase()));
  if (missing.length) throw new Error(`Missing required manifest column(s): ${missing.join(', ')}.`);
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate manifest column names.');
  if (!rows.length) throw new Error('Manifest has no line items.');
  return rows.map((row, index) => {
    const get = (name: string) => row[headers.indexOf(name.toLowerCase())] ?? '';
    const upc_raw = get('UPC');
    const upc_normalized = normalizeManifestUpc(upc_raw);
    const qty = Number(get('Qty').trim());
    const price = get('Unit Retail').trim().replace(/^\$/, '').replace(/,/g, '');
    const condition = get('Condition').trim();
    const fail = (why: string): never => { throw new Error(`Manifest row ${index + 2}: ${why}.`); };
    if (row.length !== headers.length) fail('column count does not match header');
    if (!upc_normalized) fail('UPC must be 8–14 digits (kept as text)');
    if (!Number.isSafeInteger(qty) || qty <= 0 || qty > 2147483647) fail('Qty must be a positive whole number');
    if (!/^\d+(\.\d{1,2})?$/.test(price)) fail('Unit Retail must be a nonnegative amount with at most two decimals');
    const unit_retail_cents = Math.round(Number(price) * 100);
    if (!Number.isSafeInteger(unit_retail_cents) || unit_retail_cents > 2147483647) fail('Unit Retail is too large');
    if (!condition) fail('Condition is required');
    return { line_number: index + 1, upc_raw, upc_normalized, qty, unit_retail_cents,
      condition, tcin: get('TCIN'), description: get('Item Description'), brand: get('Brand'),
      pallet_id: get('Pallet ID'), lot_id: get('Lot ID') };
  });
}
