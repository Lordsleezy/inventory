import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { totalsBalance, type InventoryBucket, type InventoryTotalsData } from './totalsMath';

/** Unit counts above the Inventory subtabs. Counts only (no money), so clerks see them too. */
export function InventoryTotals({ client, variant, refreshKey = 0, selected, onSelect, onTotals, totalOnly = false }: { client: SupabaseClient; variant: 'desktop' | 'app'; refreshKey?: number; selected?: InventoryBucket; onSelect: (bucket: InventoryBucket) => void; onTotals?: (t: InventoryTotalsData) => void; totalOnly?: boolean }) {
  const [totals, setTotals] = useState<InventoryTotalsData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void Promise.resolve(client.rpc('inventory_totals')).then(({ data, error }) => {
      if (!alive) return;
      if (error || !data) { setFailed(true); return; }
      setFailed(false); setTotals(data as InventoryTotalsData); onTotals?.(data as InventoryTotalsData);
    });
    return () => { alive = false; };
  }, [client, refreshKey]);
  void selected;
  void onSelect;
  if (failed && !totals) return null;
  const n = (v: number | undefined) => v == null ? '…' : v.toLocaleString('en-US');
  const off = totals != null && !totalsBalance(totals);
  return <div className={variant === 'app' ? 'inv-pair' : `inv-pair inv-pair-desk${totalOnly ? ' inv-pair-one' : ''}`} aria-label="Inventory totals (units)" data-balanced={off ? 'no' : 'yes'}>
    <div>
      <span>Total inventory</span>
      <strong>{n(totals?.total)}</strong>
      <small>{n(totals?.listed)} listed</small>
    </div>
    {!totalOnly && <div>
      <span>Ready to list</span>
      <strong>{n(totals?.not_listed)}</strong>
      <small className="inv-pair-alert">{n(totals?.not_ready)} not ready</small>
    </div>}
  </div>;
}
