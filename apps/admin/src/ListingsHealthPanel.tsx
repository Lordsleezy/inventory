import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type HealthRow = { marketplace: string; live_count: number; floor_count: number; vendoo_count: number; open_mismatches: number; captured_at: string };
type HealthMismatch = { id: string; marketplace: string; sku: string | null; kind: string; captured_at: string };

type Props = { client: SupabaseClient; stamp: (s: string) => string };

export function ListingsHealthPanel({ client, stamp }: Props) {
  const [health, setHealth] = useState<HealthRow[]>([]);
  const [mismatches, setMismatches] = useState<HealthMismatch[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [h, m] = await Promise.all([
        client.rpc('portal_listings_health'),
        client.rpc('portal_listings_health_mismatches', { p_limit: 40 }),
      ]);
      if (h.error) throw h.error;
      if (m.error) throw m.error;
      setHealth((h.data || []) as HealthRow[]);
      setMismatches((m.data || []) as HealthMismatch[]);
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  return <section className="panel">
    <div className="section-head"><div><div className="eyebrow">MARKETPLACE TRUTH</div><h2>Listings health</h2>
      <p className="hint" style={{ margin: 0 }}>Live marketplace counts vs Floor vs Vendoo. Open mismatches are logged by the reconciliation job.</p></div>
      <button type="button" className="secondary" onClick={() => void load()}>Refresh</button></div>
    {error && <div className="alert" role="alert">{error}</div>}
    {health.length === 0 ? <div className="empty">No health snapshot yet — reconciliation job has not written one.</div> : <div className="stats">
      {health.map(h => <div className="stat" key={h.marketplace}><span>{h.marketplace} · live {h.live_count}</span>
        <strong>{`Floor ${h.floor_count} · Vendoo ${h.vendoo_count}${h.open_mismatches ? ` · ${h.open_mismatches} open` : ''}`}</strong></div>)}
    </div>}
    {mismatches.length > 0 && <div style={{ marginTop: '0.75rem' }}>{mismatches.slice(0, 12).map(m => <div className="payout-row" key={m.id}><div><strong>{m.marketplace} · {m.kind}</strong><small style={{ display: 'block' }}>{m.sku ? `SKU ${m.sku}` : '—'} · {stamp(m.captured_at)}</small></div></div>)}</div>}
  </section>;
}
