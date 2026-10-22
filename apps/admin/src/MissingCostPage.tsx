import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = {
  sku: string;
  title: string;
  state: string;
  ask_cents: number | null;
  received_at: string;
  sold_at: string | null;
  sold_channel: string | null;
  sold_price_cents: number | null;
};
type Props = {
  client: SupabaseClient;
  money: (n: number) => string;
  stamp: (s: string) => string;
  onChanged: () => void;
  embedded?: boolean;
};
const entry = /^\d*(?:\.\d{0,2})?$/;
const PAGE = 100;

/** Units with no acquisition cost. Sold ones come first because their payouts are waiting on it. */
export function MissingCostPage({ client, money, stamp, onChanged, embedded }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [sold, setSold] = useState(0);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_units_missing_cost', { p_limit: PAGE, p_offset: 0 });
    if (e) {
      setError(e.message);
      return;
    }
    const d = data as { total: number; sold: number; rows: Row[] };
    setRows(d.rows);
    setTotal(d.total);
    setSold(d.sold);
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(sku: string) {
    const raw = (vals[sku] || '').trim();
    if (raw === '') return;
    const cents = Math.round(Number(raw) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      setError('Enter the cost like 12.50 (0 is allowed for free items).');
      return;
    }
    setSaving(sku);
    setError('');
    const { error: e } = await client.rpc('portal_set_unit_cost', { p_sku: sku, p_cost_cents: cents });
    setSaving(null);
    if (e) {
      setError(e.message);
      return;
    }
    setVals((v) => {
      const n = { ...v };
      delete n[sku];
      return n;
    });
    await load();
    onChanged();
  }

  return (
    <>
      {!embedded && (
        <header>
          <div>
            <div className="eyebrow">INVENTORY</div>
            <h1>Missing cost</h1>
            <p>
              What we paid for each unit. Sold units are first: their online payouts are waiting on the cost and calculate
              the moment you save it.
            </p>
          </div>
        </header>
      )}
      {embedded && (
        <div className="section-head" style={{ marginBottom: 12 }}>
          <div>
            <h2>Missing cost</h2>
            <p className="hint" style={{ margin: 0 }}>
              Sold units first — online payouts calculate when you save cost.
            </p>
          </div>
        </div>
      )}
      {error && (
        <div className="alert" role="alert">
          {error}
          <button onClick={() => setError('')}>Dismiss</button>
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>Units missing cost</span>
          <strong>{total}</strong>
        </div>
        <div className="stat">
          <span>Of those, already sold</span>
          <strong>{sold}</strong>
        </div>
      </div>
      <section className="panel">
        {rows === null ? (
          <p className="hint">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="empty">Every unit has a cost.</div>
        ) : (
          <div className="missing-cost-list">
            {rows.map((r) => {
              const status =
                r.state === 'sold'
                  ? `sold${r.sold_channel ? ` · ${r.sold_channel}` : ''}${r.sold_at ? ` · ${stamp(r.sold_at)}` : ''}`
                  : r.state === 'available'
                    ? 'in stock'
                    : r.state;
              const price =
                r.sold_price_cents != null
                  ? money(r.sold_price_cents)
                  : r.ask_cents != null
                    ? money(r.ask_cents)
                    : '—';
              return (
                <article className="missing-cost-row" key={r.sku}>
                  <div className="missing-cost-top">
                    <strong className="missing-cost-sku">SKU {r.sku}</strong>
                    <span className={`tag${r.state === 'sold' ? ' warn' : ''}`}>{status}</span>
                  </div>
                  <div className="missing-cost-title">{r.title || 'Untitled'}</div>
                  <div className="missing-cost-meta">Price {price}</div>
                  <div className="missing-cost-actions">
                    <label className="missing-cost-field">
                      Cost ($)
                      <input
                        inputMode="decimal"
                        aria-label={`Cost for SKU ${r.sku}`}
                        placeholder="0.00"
                        value={vals[r.sku] || ''}
                        onChange={(e) => {
                          if (entry.test(e.target.value)) setVals({ ...vals, [r.sku]: e.target.value });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void save(r.sku);
                        }}
                      />
                    </label>
                    <button
                      disabled={saving === r.sku || !(vals[r.sku] || '').trim()}
                      onClick={() => void save(r.sku)}
                    >
                      {saving === r.sku ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {total > PAGE && <p className="hint">Showing the first {PAGE}. Fill some in and the rest move up.</p>}
      </section>
    </>
  );
}
