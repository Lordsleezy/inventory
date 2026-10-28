import type { SupabaseClient } from '@supabase/supabase-js';

export function locationCompare(a: string, b: string): number {
  const left = a.split('-').map(Number), right = b.split('-').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

export function locationParts(code?: string | null) {
  if (!code) return null;
  const [bay, row, bin] = code.split('-').map(Number);
  if (!Number.isFinite(bay) || !Number.isFinite(row)) return null;
  return { bay, row, bin: Number.isFinite(bin) ? bin : null, display: `BAY ${bay}`, slot: `R${row}${Number.isFinite(bin) ? `-B${bin}` : ''}` };
}

export async function loadOrderLocations(client: SupabaseClient, storeId: string, skus: string[]) {
  const result: Record<string, string[]> = {};
  const unique = [...new Set(skus.filter((sku) => sku && sku !== 'UNMATCHED'))];
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await client.from('unit_location_stock')
      .select('sku,location_code').eq('store_id', storeId).in('sku', unique.slice(i, i + 100));
    if (error) throw error;
    for (const row of data || []) (result[row.sku] ||= []).push(row.location_code);
  }
  const missing = unique.filter(sku => !result[sku]?.length);
  for (let i = 0; i < missing.length; i += 100) {
    const { data, error } = await client.from('unit_pick_locations')
      .select('sku,location_code').eq('store_id', storeId).in('sku', missing.slice(i, i + 100));
    if (error) throw error;
    for (const row of data || []) result[row.sku] = [row.location_code];
  }
  const moved = unique.filter(sku => !result[sku]?.length);
  for (let i = 0; i < moved.length; i += 100) {
    const { data, error } = await client.from('unit_location_moves')
      .select('sku,to_location,moved_at').eq('store_id', storeId).in('sku', moved.slice(i, i + 100))
      .order('moved_at', { ascending: false });
    if (error) throw error;
    for (const row of data || []) if (!result[row.sku]?.length) result[row.sku] = [row.to_location];
  }
  for (const codes of Object.values(result)) codes.sort(locationCompare);
  return result;
}
