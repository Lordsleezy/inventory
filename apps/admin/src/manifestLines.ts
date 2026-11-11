import { parseManifestCsv } from './manifestCount.ts';

export type ManifestLine = {
  line_number: number; upc_raw: string; upc_normalized: string; tcin: string;
  item_number: string; description: string; brand: string;
  category: string; seller_category: string; upc_type: string;
  qty: number; unit_retail_cents: number;
  condition: string; pallet_id: string; lot_id: string;
};

/** Preserve the UPC-A zero; remove only the EAN/GTIN wrapper zeros. Target 49 codes are UPCs too.
 *  B-Stock sometimes quotes UPCs with a trailing comma inside the field (`041333051543,`). */
export function normalizeManifestUpc(raw: string): string {
  const digits = raw.replace(/[\s,-]/g, '');
  if (!/^\d{8,14}$/.test(digits)) return '';
  if (digits.length === 14 && digits.startsWith('00')) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

function cell(headers: string[], row: string[], name: string): string {
  const i = headers.indexOf(name.toLowerCase());
  return i < 0 ? '' : (row[i] ?? '');
}

/** Prefer TCIN; Costco sheets use Item # / Item Number when TCIN is absent. */
function itemNumberFromRow(headers: string[], row: string[]): string {
  return cell(headers, row, 'Item #').trim()
    || cell(headers, row, 'Item Number').trim()
    || '';
}

/** First matching header wins (Floor clean CSV + raw B-Stock aliases). */
function firstCell(headers: string[], row: string[], names: string[]): string {
  for (const name of names) {
    const value = cell(headers, row, name).trim();
    if (value) return value;
  }
  return '';
}

export function parseManifestLines(source: string): ManifestLine[] {
  const rows = parseManifestCsv(source.replace(/^\uFEFF/, '')).filter(row => row.some(cell => cell.trim()));
  const headers = (rows.shift() || []).map(cell => cell.trim().toLowerCase());
  const has = (names: string[]) => names.some(name => headers.includes(name.toLowerCase()));
  const missing = [];
  if (!has(['UPC'])) missing.push('UPC');
  if (!has(['Qty', 'Quantity'])) missing.push('Qty');
  if (!has(['Unit Retail', 'unit_retail'])) missing.push('Unit Retail');
  if (!has(['Condition', 'manifest_condition'])) missing.push('Condition');
  if (missing.length) throw new Error(`Missing required manifest column(s): ${missing.join(', ')}.`);
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate manifest column names.');
  if (!rows.length) throw new Error('Manifest has no line items.');
  return rows.map((row, index) => {
    // Trailing empty cells from spreadsheet exports are common; trim to header width.
    let cells = row;
    if (cells.length > headers.length && cells.slice(headers.length).every(value => !String(value ?? '').trim())) {
      cells = cells.slice(0, headers.length);
    }
    const upc_raw = firstCell(headers, cells, ['UPC']);
    const upc_normalized = normalizeManifestUpc(upc_raw);
    const qty = Number(firstCell(headers, cells, ['Qty', 'Quantity']));
    const price = firstCell(headers, cells, ['Unit Retail', 'unit_retail']).replace(/^\$/, '').replace(/,/g, '');
    const condition = firstCell(headers, cells, ['Condition', 'manifest_condition']);
    const fail = (why: string): never => { throw new Error(`Manifest row ${index + 2}: ${why}.`); };
    if (cells.length !== headers.length) fail('column count does not match header');
    if (!upc_normalized) fail('UPC must be 8–14 digits (kept as text)');
    if (!Number.isSafeInteger(qty) || qty <= 0 || qty > 2147483647) fail('Qty must be a positive whole number');
    if (!/^\d+(\.\d{1,2})?$/.test(price)) fail('Unit Retail must be a nonnegative amount with at most two decimals');
    const unit_retail_cents = Math.round(Number(price) * 100);
    if (!Number.isSafeInteger(unit_retail_cents) || unit_retail_cents > 2147483647) fail('Unit Retail is too large');
    if (!condition) fail('Condition is required');
    const item_number = itemNumberFromRow(headers, cells)
      || firstCell(headers, cells, ['costco_item_number', 'Item #', 'Item Number']);
    const tcin = firstCell(headers, cells, ['TCIN']) || item_number;
    const description = firstCell(headers, cells, ['Item Description', 'description', 'Description']);
    const brand = firstCell(headers, cells, ['Brand', 'brand']);
    return {
      line_number: index + 1, upc_raw, upc_normalized, qty, unit_retail_cents,
      condition, tcin, item_number,
      description, brand,
      category: firstCell(headers, cells, ['Category', 'category']),
      seller_category: firstCell(headers, cells, ['Seller Category', 'seller_category']),
      upc_type: firstCell(headers, cells, ['UPC Type', 'UPC_Type', 'upc_type']),
      pallet_id: firstCell(headers, cells, ['Pallet ID', 'pallet_id']),
      lot_id: firstCell(headers, cells, ['Lot ID', 'lot_id']),
    };
  });
}
