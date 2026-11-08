import type { SupabaseClient } from '@supabase/supabase-js';

/** All non-voided portal expenses for payout balances (no row cap). */
export async function loadAllPortalExpenses<T extends Record<string, unknown> = Record<string, unknown>>(
  client: SupabaseClient,
  storeId: string,
): Promise<T[]> {
  const expenses: T[] = [];
  for (let offset = 0;; offset += 1000) {
    const res = await client
      .from('portal_expenses')
      .select('*')
      .eq('store_id', storeId)
      .order('spent_on', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + 999);
    if (res.error) throw new Error(res.error.message);
    const batch = (res.data || []) as T[];
    expenses.push(...batch);
    if (batch.length < 1000) break;
  }
  return expenses;
}

export async function countPortalExpenses(client: SupabaseClient, storeId: string): Promise<number> {
  const { count, error } = await client
    .from('portal_expenses')
    .select('*', { count: 'exact', head: true })
    .eq('store_id', storeId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}
