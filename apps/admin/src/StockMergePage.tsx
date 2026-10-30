import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Candidate = {
  identity: string; title: string; sku_count: number; unit_count: number; keep_sku: string;
  skus: string[]; price_cents: number | null; condition: string | null; cost_each_cents: number | null; do_not_list: boolean;
};

export function StockMergePage({ client, money }: { client: SupabaseClient; money: (n: number) => string }) {
  const [rows, setRows] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: e } = await client.rpc('portal_stock_merge_candidates');
    if (e) setError(e.message);
    else setRows((data || []) as Candidate[]);
    setLoading(false);
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  async function merge(candidate: Candidate) {
    if (!window.confirm(`Merge ${candidate.sku_count} SKUs (${candidate.unit_count} units) into SKU ${candidate.keep_sku}? Sold items are excluded and will not be changed.`)) return;
    setBusy(true); setError('');
    const { error: e } = await client.rpc('portal_stock_merge', { p_skus: candidate.skus });
    if (e) setError(e.message); else await load();
    setBusy(false);
  }

  async function mergeAll() {
    if (!rows.length || !window.confirm(`Merge all ${rows.length} reviewed sets? This retires their higher SKUs as aliases.`)) return;
    setBusy(true); setError('');
    for (const row of rows) {
      const { error: e } = await client.rpc('portal_stock_merge', { p_skus: row.skus });
      if (e) { setError(`Stopped after completed sets. SKU ${row.keep_sku}: ${e.message}`); break; }
    }
    await load(); setBusy(false);
  }

  return <section className="panel">
    <header><div><div className="eyebrow">INVENTORY TOOLS</div><h1>Merge duplicates</h1>
      <p>Review identical, in-stock, unsold units. Floor keeps the lowest SKU, combines on-hand quantity, averages recorded costs, and makes retired SKUs scan aliases. Nothing merges until you choose a button.</p></div></header>
    {error && <p className="alert" role="alert">{error}</p>}
    {loading ? <p>Finding duplicate sets…</p> : rows.length === 0 ? <p>No eligible duplicate sets found.</p> : <>
      <p>{rows.length} sets · {rows.reduce((n, row) => n + row.unit_count, 0)} physical units</p>
      <div className="ledger-list">{rows.map(row => <article className="ledger-row" key={`${row.identity}:${row.keep_sku}`}>
        <div><strong>{row.title || 'Untitled'} · {row.unit_count} units across {row.sku_count} SKUs</strong>
          <span>SKUs {row.skus.join(', ')} · keep {row.keep_sku}</span>
          <span>{row.price_cents == null ? 'No price' : money(row.price_cents)} each · {row.condition || 'No condition'} · {row.do_not_list ? 'Not for sale' : 'For sale'}</span>
          <span>Cost each after merge: {row.cost_each_cents == null ? 'missing' : money(row.cost_each_cents)}</span>
        </div><button type="button" className="secondary" disabled={busy} onClick={() => void merge(row)}>Merge set</button>
      </article>)}</div>
      <button type="button" disabled={busy} onClick={() => void mergeAll()}>{busy ? 'Working…' : `Merge all ${rows.length} sets`}</button>
    </>}
    <button type="button" className="secondary" disabled={loading || busy} onClick={() => void load()}>Refresh candidates</button>
  </section>;
}
