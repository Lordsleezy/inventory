import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { totalsBalance, type InventoryTotalsData } from './totalsMath';

/** Four unit counts above the Inventory subtabs. Counts only (no money), so clerks see them too. */
export function InventoryTotals({ client, variant, refreshKey = 0 }: { client: SupabaseClient; variant: 'desktop' | 'app'; refreshKey?: number }) {
  const [totals, setTotals] = useState<InventoryTotalsData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void Promise.resolve(client.rpc('inventory_totals')).then(({ data, error }) => {
      if (!alive) return;
      if (error || !data) { setFailed(true); return; }
      setFailed(false); setTotals(data as InventoryTotalsData);
    });
    return () => { alive = false; };
  }, [client, refreshKey]);
  if (failed && !totals) return null;
  const cells: [string, number | undefined, string][] = [
    ['Total inventory', totals?.total, 'Every unsold unit, including Defective'],
    ['Listed', totals?.listed, 'Live on the website, eBay, Amazon, TikTok Shop or Depop'],
    ['Not listed', totals?.not_listed, 'Sellable, but not live anywhere'],
    ['Defective / not sellable', totals?.defective, 'Everything in Defective, including do-not-list'],
  ];
  const off = totals != null && !totalsBalance(totals);
  return <div className={variant === 'app' ? 'app-totals' : 'inventory-totals'} aria-label="Inventory totals (units)" data-balanced={off ? 'no' : 'yes'}>
    {cells.map(([label, n, hint]) => <div className={variant === 'app' ? 'app-total' : 'stat'} key={label} title={hint}>
      <span>{label}</span><strong>{n == null ? '…' : n.toLocaleString('en-US')}</strong>
    </div>)}
  </div>;
}
