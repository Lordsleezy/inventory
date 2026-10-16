import { floorCloud, stripCostFromUnit, webDerivativePath } from '@floor/cloud';

export type RegisterUnit = {
  sku: string;
  title: string;
  brand: string | null;
  model: string | null;
  category: string | null;
  condition: string | null;
  askCents: number | null;
  state: string;
  qtyOnHand: number;
  photoUrl: string | null;
};

const BASE_COLUMNS = 'sku, title, brand, model, category, condition, ask_cents, state';
const SELECT = `${BASE_COLUMNS}, qty_on_hand`;

function toUnit(row: Record<string, unknown>): RegisterUnit {
  const clean = stripCostFromUnit(row);
  const qty = row.qty_on_hand;
  return {
    sku: String(clean.sku ?? ''),
    title: String(clean.title ?? ''),
    brand: clean.brand ? String(clean.brand) : null,
    model: clean.model ? String(clean.model) : null,
    category: clean.category ? String(clean.category) : null,
    condition: clean.condition ? String(clean.condition) : null,
    askCents: typeof clean.ask_cents === 'number' ? clean.ask_cents : null,
    state: String(clean.state ?? 'available'),
    qtyOnHand: typeof qty === 'number' && qty > 0 ? qty : 1,
    photoUrl: null,
  };
}

function escapeIlike(value: string): string {
  return value.replace(/[%_,]/g, c => `\\${c}`);
}

/** Lightweight warm list — never pull thousands of rows (freezes phones). */
export async function loadAvailableUnits(limit = 80): Promise<RegisterUnit[]> {
  const sb = floorCloud();
  const first = await sb
    .from('units_pos')
    .select(SELECT)
    .eq('state', 'available')
    .order('sku', { ascending: false })
    .limit(limit);
  if (!first.error) return (first.data ?? []).map(row => toUnit(row as Record<string, unknown>));
  const fallback = await sb
    .from('units_pos')
    .select(BASE_COLUMNS)
    .eq('state', 'available')
    .order('sku', { ascending: false })
    .limit(limit);
  if (fallback.error) throw fallback.error;
  return (fallback.data ?? []).map(row => toUnit(row as Record<string, unknown>));
}

/** Server-side search for scan / typeahead. Prefer exact SKU, then ilike. */
export async function queryAvailableUnits(query: string, limit = 16): Promise<RegisterUnit[]> {
  const q = query.trim();
  if (!q) return [];
  const sb = floorCloud();

  const exact = await sb
    .from('units_pos')
    .select(SELECT)
    .eq('state', 'available')
    .eq('sku', q)
    .maybeSingle();
  if (!exact.error && exact.data) return [toUnit(exact.data as Record<string, unknown>)];

  if (exact.error) {
    const exactFallback = await sb
      .from('units_pos')
      .select(BASE_COLUMNS)
      .eq('state', 'available')
      .eq('sku', q)
      .maybeSingle();
    if (!exactFallback.error && exactFallback.data) return [toUnit(exactFallback.data as Record<string, unknown>)];
  }

  const pattern = `%${escapeIlike(q)}%`;
  const fuzzy = await sb
    .from('units_pos')
    .select(SELECT)
    .eq('state', 'available')
    .or(`sku.ilike.${pattern},title.ilike.${pattern},brand.ilike.${pattern},model.ilike.${pattern},upc.ilike.${pattern}`)
    .order('sku', { ascending: false })
    .limit(limit);
  if (!fuzzy.error) return (fuzzy.data ?? []).map(row => toUnit(row as Record<string, unknown>));

  const fuzzyFallback = await sb
    .from('units_pos')
    .select(BASE_COLUMNS)
    .eq('state', 'available')
    .or(`sku.ilike.${pattern},title.ilike.${pattern},brand.ilike.${pattern},model.ilike.${pattern}`)
    .order('sku', { ascending: false })
    .limit(limit);
  if (fuzzyFallback.error) throw fuzzyFallback.error;
  return (fuzzyFallback.data ?? []).map(row => toUnit(row as Record<string, unknown>));
}

/** Local filter kept for any already-loaded rows (Refresh warm list). */
export function searchUnits(units: RegisterUnit[], query: string): RegisterUnit[] {
  const q = query.trim().toLowerCase();
  const rows = units.filter(u => u.state === 'available');
  if (!q) return rows;
  return rows.filter(u =>
    [u.sku, u.title, u.brand, u.model, u.category].some(v => String(v || '').toLowerCase().includes(q)));
}

const thumbCache = new Map<string, string | null>();

export async function unitThumbUrl(sku: string): Promise<string | null> {
  if (thumbCache.has(sku)) return thumbCache.get(sku) ?? null;
  try {
    const sb = floorCloud();
    const { data } = await sb
      .from('photos')
      .select('path, is_primary')
      .eq('sku', sku)
      .order('is_primary', { ascending: false })
      .limit(1)
      .maybeSingle();
    const path = data?.path ? String(data.path) : '';
    if (!path) {
      thumbCache.set(sku, null);
      return null;
    }
    let signed = await sb.storage.from('unit-photos').createSignedUrl(webDerivativePath(path, 400), 3600);
    if (!signed.data?.signedUrl) signed = await sb.storage.from('unit-photos').createSignedUrl(path, 3600);
    const url = signed.data?.signedUrl ?? null;
    thumbCache.set(sku, url);
    return url;
  } catch {
    thumbCache.set(sku, null);
    return null;
  }
}
