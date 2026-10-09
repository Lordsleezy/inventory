import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

export type QueueRow = {
  id: string; sku: string; reason: string; detail: Record<string, unknown>;
  best_viable_price_cents: number | null; profit_cents: number | null; status: string;
  title: string; condition: string | null; ask_cents: number | null; created_at: string;
};

type Props = {
  client: SupabaseClient;
  money: (n: number) => string;
  busy: boolean;
  run: (f: () => Promise<void>) => Promise<void>;
  embedded?: boolean;
};

const reasonLabel = (reason: string) => {
  if (/missing.?photo|no_photo|photo/i.test(reason)) return 'Missing photos';
  if (/cannot_beat|capped_under|retail/i.test(reason)) return "Can't beat retail";
  if (/no_sold_comps|collectible|comp/i.test(reason)) return 'Collectible without comps';
  if (/no_reliable_retail|missing.?data|no_retail/i.test(reason)) return 'Missing data / no retail';
  if (/sku_already_active|duplicate/i.test(reason)) return 'Already live elsewhere';
  if (/sold|floor_state/i.test(reason)) return 'Sold / floor state';
  return reason.replace(/_/g, ' ');
};

export function YourCallPanel({ client, money, busy, run, embedded }: Props) {
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [error, setError] = useState('');

  const loadQueue = useCallback(async () => {
    try {
      const { data, error: e } = await client.rpc('portal_listing_queue');
      if (e) throw e;
      setQueue((data || []) as QueueRow[]);
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [client]);

  useEffect(() => { void loadQueue(); }, [loadQueue]);

  async function decide(id: string, action: 'approve' | 'keep_instore' | 'dismiss', priceCents?: number) {
    await run(async () => {
      const { error: e } = await client.rpc('portal_listing_queue_decide', { p_id: id, p_action: action, p_price_cents: priceCents ?? null });
      if (e) throw e;
      await loadQueue();
    });
  }
  async function decideBulk(action: 'approve' | 'keep_instore' | 'dismiss', reason: string) {
    await run(async () => {
      const { error: e } = await client.rpc('portal_listing_queue_decide_bulk', { p_action: action, p_ids: null, p_reason: reason, p_price_cents: null });
      if (e) throw e;
      await loadQueue();
    });
  }

  const queueGroups = useMemo(() => {
    const map = new Map<string, { reason: string; rows: QueueRow[]; valueCents: number }>();
    for (const q of queue) {
      const reason = q.reason || 'other';
      let g = map.get(reason);
      if (!g) { g = { reason, rows: [], valueCents: 0 }; map.set(reason, g); }
      g.rows.push(q);
      g.valueCents += q.ask_cents ?? q.best_viable_price_cents ?? 0;
    }
    return [...map.values()].sort((a, b) => b.rows.length - a.rows.length);
  }, [queue]);

  return <>
    {!embedded && <header><div><div className="eyebrow">MARKETPLACE PRICING</div><h1>Your Call</h1>
      <p>Items held because they could not clear the pricing rule. Approve with an online price (does not change Floor ask), keep in-store, or dismiss.</p></div>
      <button className="secondary" onClick={() => void loadQueue()}>Refresh</button></header>}
    {embedded && <div className="section-head" style={{ marginBottom: 12 }}><div><h2>Your Call</h2>
      <p className="hint" style={{ margin: 0 }}>Listing review queue — approve online prices, keep in-store, or dismiss. Bulk actions clear each group quickly.</p></div>
      <button className="secondary" onClick={() => void loadQueue()}>Refresh</button></div>}
    {error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    <div className="stats">{queueGroups.map(g => <div className="stat" key={g.reason}><span>{reasonLabel(g.reason)}</span><strong>{`${g.rows.length} · ${money(g.valueCents)}`}</strong></div>)}</div>
    {queue.length === 0 ? <section className="panel"><div className="empty">Nothing waiting for review.</div></section> : queueGroups.map(g => {
      const canBeatRetail = /cannot_beat|capped_under|retail/i.test(g.reason);
      const missingPhoto = /missing.?photo|no_photo|photo/i.test(g.reason);
      const sorted = [...g.rows].sort((a, b) => (b.ask_cents ?? b.best_viable_price_cents ?? 0) - (a.ask_cents ?? a.best_viable_price_cents ?? 0));
      return <section className="panel" key={g.reason}>
        <div className="section-head">
          <div>
            <div className="eyebrow">{g.rows.length} ITEMS · {money(g.valueCents)}</div>
            <h2>{reasonLabel(g.reason)}</h2>
            <p className="hint" style={{ margin: 0 }}>{g.reason}</p>
          </div>
          <div className="actions">
            {canBeatRetail && <button className="secondary" disabled={busy} onClick={() => void decideBulk('keep_instore', g.reason)}>Keep all in-store only</button>}
            {missingPhoto && <button className="secondary" disabled={busy} onClick={() => void decideBulk('dismiss', g.reason)}>Dismiss all (shoot later)</button>}
            {!canBeatRetail && !missingPhoto && <button className="secondary" disabled={busy} onClick={() => void decideBulk('keep_instore', g.reason)}>Keep all in store</button>}
            <button className="text-button" disabled={busy} onClick={() => void decideBulk('dismiss', g.reason)}>Dismiss all</button>
          </div>
        </div>
        {missingPhoto && <p className="hint">Shooting list (highest ask first): {sorted.map(q => `${q.sku} ${q.title || ''} ${q.ask_cents != null ? money(q.ask_cents) : ''}`).join(' · ')}</p>}
        {sorted.map(q => {
          const d = q.detail || {};
          const approveDefault = q.best_viable_price_cents ?? 0;
          return <div className="payout-row" key={q.id} style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
            <div style={{ flex: '1 1 16rem' }}>
              <strong>SKU {q.sku} · {q.title || 'Untitled'}</strong>
              <small style={{ display: 'block' }}>{q.condition ? `${q.condition} · ` : ''}{q.ask_cents != null ? `Floor ask ${money(q.ask_cents)}` : 'No Floor ask'}</small>
              <small style={{ display: 'block' }}>Retail {d.highest_retail_usd != null ? `$${d.highest_retail_usd}` : '—'} · Sold comps {d.sold_comp_usd != null ? `$${d.sold_comp_usd}` : '—'} · Best list {q.best_viable_price_cents != null ? money(q.best_viable_price_cents) : '—'} · Profit {q.profit_cents != null ? money(q.profit_cents) : '—'}</small>
              {Boolean(d.package_measure_status || d.package) && <small style={{ display: 'block' }}>Package <b>{String(d.package_measure_status || 'unknown')}</b>{d.package && typeof d.package === 'object' ? ` · ${String((d.package as Record<string, unknown>).weight_lb ?? '')} lb · ${String((d.package as Record<string, unknown>).length_in ?? '')}×${String((d.package as Record<string, unknown>).width_in ?? '')}×${String((d.package as Record<string, unknown>).height_in ?? '')} in` : ''}{d.package_measure_source ? ` · ${String(d.package_measure_source).slice(0, 120)}` : ''}</small>}
            </div>
            <div className="actions">
              <button disabled={busy || !approveDefault} onClick={() => void decide(q.id, 'approve', approveDefault)}>Approve {approveDefault ? money(approveDefault) : ''}</button>
              <button className="secondary" disabled={busy} onClick={() => void decide(q.id, 'keep_instore')}>Keep in store</button>
              <button className="text-button" disabled={busy} onClick={() => void decide(q.id, 'dismiss')}>Dismiss</button>
            </div>
          </div>;
        })}
      </section>;
    })}
  </>;
}
