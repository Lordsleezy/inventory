import type { SupabaseClient } from '@supabase/supabase-js';

export function locationCompare(a: string, b: string): number {
  const left = a.split('-').map(Number), right = b.split('-').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
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
  for (const codes of Object.values(result)) codes.sort(locationCompare);
  return result;
}
