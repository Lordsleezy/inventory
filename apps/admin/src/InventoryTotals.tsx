import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { INVENTORY_BUCKET_LABELS, totalsBalance, type InventoryBucket, type InventoryTotalsData } from './totalsMath';

/** Unit counts above the Inventory subtabs. Counts only (no money), so clerks see them too. */
export function InventoryTotals({ client, variant, refreshKey = 0, selected, onSelect }: { client: SupabaseClient; variant: 'desktop' | 'app'; refreshKey?: number; selected?: InventoryBucket; onSelect: (bucket: InventoryBucket) => void }) {
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
  const cells: [InventoryBucket, number | undefined, string][] = [
    ['total', totals?.total, 'Every unsold unit, including DNS and Defective'],
    ['listed', totals?.listed, 'Stocked units live on the business eBay account, counted once'],
    ['not_listed', totals?.not_listed, 'Ready items without a live eBay listing. Never-list and DNS are not in this count.'],
    ['not_ready', totals?.not_ready, 'Unlisted items missing required listing details'],
    ['dns', totals?.dns, 'Store / pickup stock; never on eBay, Amazon, TikTok or Depop'],
    ['defective', totals?.defective, 'Defective and do-not-list stock outside DNS'],
  ];
  const off = totals != null && !totalsBalance(totals);
  return <div className={variant === 'app' ? 'app-totals' : 'inventory-totals'} aria-label="Inventory totals (units)" data-balanced={off ? 'no' : 'yes'}>
    {cells.map(([bucket, n, hint]) => <button type="button" className={`${variant === 'app' ? 'app-total' : 'stat'} inventory-total-button`} key={bucket} title={hint} aria-pressed={selected === bucket} onClick={() => onSelect(bucket)}>
      <span>{INVENTORY_BUCKET_LABELS[bucket]}</span><strong>{n == null ? '…' : bucket === 'not_listed' && totals?.not_listed_skus != null ? `${totals.not_listed_skus.toLocaleString('en-US')} items` : n.toLocaleString('en-US')}</strong>
      {bucket === 'not_listed' && totals?.not_listed_pieces != null && <small>{totals.not_listed_pieces.toLocaleString('en-US')} pieces</small>}
    </button>)}
    {totals?.never_list ? <p className="hint">Never list: {totals.never_list.toLocaleString('en-US')} pieces, not counted in Not listed.</p> : null}
  </div>;
}
