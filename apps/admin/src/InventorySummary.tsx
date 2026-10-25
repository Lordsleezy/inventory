import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Counts = { total: number; listed: number; not_listed: number; defective: number };

export function InventorySummary({ client, refresh = 0, appMode = false }: {
  client: SupabaseClient; refresh?: number; appMode?: boolean;
}) {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setError(false);
    void client.rpc('portal_inventory_unit_summary').then(({ data, error: rpcError }) => {
      if (!active) return;
      if (rpcError) { setError(true); return; }
      setCounts(data as Counts);
    });
    return () => { active = false; };
  }, [client, refresh]);

  return <section className={appMode ? 'inventory-summary inventory-summary-app' : 'inventory-summary'} aria-label="Inventory totals in units">
    {([
      ['total', 'Total inventory'],
      ['listed', 'Listed'],
      ['not_listed', 'Not listed'],
      ['defective', 'Defective / not sellable'],
    ] as const).map(([key, label]) => <div className="inventory-summary-card" key={key}>
      <span>{label}</span><strong>{error ? '—' : counts ? counts[key].toLocaleString() : '…'}</strong>
    </div>)}
    {error && <p className="inventory-summary-error" role="alert">Couldn’t load inventory totals.</p>}
  </section>;
}
