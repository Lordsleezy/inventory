import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  acquisitionCostCents,
  mergeMissingCost,
  missingCostSubmitError,
  takeMissingCostPage,
  type MissingCostSource,
} from '../missingCost';
import { shortError } from './shortError';

type Props = {
  client: SupabaseClient;
  query: string;
  stamp: (s: string) => string;
  onOpen: (sku: string) => void;
  refreshKey?: number;
  /** Unfiltered total, so the chip count matches the list. */
  onCount: (count: number) => void;
};

const PAGE_SIZE = 40;
const RPC_LIMIT = 100;

function itemName(unit: MissingCostSource) {
  return [unit.brand, unit.model].filter(Boolean).join(' ') || unit.title || 'Untitled';
}

async function loadStatus(client: SupabaseClient, status: 'in_stock' | 'sold', query: string) {
  const out: MissingCostSource[] = [];
  const seen = new Set<string>();
  let target: number | null = null;
  for (let offset = 0; offset < 3000; offset += RPC_LIMIT) {
    const { data, error } = await client.rpc('receive_inventory_list', {
      p_query: query,
      p_status: status,
      p_unfinished: false,
      p_sort: 'sku',
      p_offset: offset,
      p_limit: RPC_LIMIT,
      p_location: 'all',
    });
    if (error) throw error;
    const payload = data as { items?: MissingCostSource[]; totals?: { missing_cost?: number | null } } | null;
    if (target == null && typeof payload?.totals?.missing_cost === 'number') target = payload.totals.missing_cost;
    const items = payload?.items || [];
    const page = takeMissingCostPage(items);
    for (const unit of page.units) {
      if (seen.has(unit.sku)) continue;
      seen.add(unit.sku);
      out.push(unit);
    }
    if (target != null && out.length >= target) break;
    if (items.length < RPC_LIMIT) break;
    if (page.done && page.units.length === 0) break;
  }
  return out;
}

/** In-stock and sold units with no acquisition cost. Cost is saved with portal_set_unit_cost. */
export function MissingCostList({ client, query, stamp, onOpen, refreshKey = 0, onCount }: Props) {
  const [rows, setRows] = useState<MissingCostSource[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [rowError, setRowError] = useState<{ sku: string; message: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const hidden = useRef(new Set<string>());
  const onCountRef = useRef(onCount);
  onCountRef.current = onCount;

  useEffect(() => { setOffset(0); }, [query]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const [stock, sold] = await Promise.all([
          loadStatus(client, 'in_stock', query),
          loadStatus(client, 'sold', query),
        ]);
        if (!alive) return;
        const units = mergeMissingCost([stock, sold]).filter(unit => !hidden.current.has(unit.sku));
        setRows(units);
        if (!query.trim()) onCountRef.current(units.length);
        setLoading(false);
      } catch (err) {
        if (!alive) return;
        setError(shortError(err));
        setRows([]);
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [client, query, refreshKey]);

  async function submit(sku: string) {
    const raw = vals[sku] || '';
    const message = missingCostSubmitError(raw);
    if (message) {
      setRowError({ sku, message });
      return;
    }
    const cents = acquisitionCostCents(raw);
    if (cents == null) return;
    setSaving(sku);
    setRowError(null);
    setError('');
    const { error: saveError } = await client.rpc('portal_set_unit_cost', { p_sku: sku, p_cost_cents: cents });
    setSaving(null);
    if (saveError) {
      setRowError({ sku, message: shortError(saveError) });
      return;
    }
    hidden.current.add(sku);
    setVals(prev => {
      const next = { ...prev };
      delete next[sku];
      return next;
    });
    setRows(prev => {
      const next = (prev || []).filter(unit => unit.sku !== sku);
      if (!query.trim()) onCountRef.current(next.length);
      return next;
    });
  }

  const page = (rows || []).slice(offset, offset + PAGE_SIZE);

  return (
    <>
      {error && <p className="app-inline-error" role="alert">{error}</p>}
      {loading && !rows && <p className="app-footer-count">Loading…</p>}
      {loading && rows ? <p className="app-footer-count">Updating…</p> : null}
      <div className="app-group">
        {page.map(unit => (
          <div className="app-cost-block" key={unit.sku}>
            <div className="app-row app-row-cost">
              <button type="button" className="app-row-text app-cost-open" onClick={() => onOpen(unit.sku)}>
                <strong>{itemName(unit)}</strong>
                <small>
                  {unit.sku}
                  {unit.state === 'sold'
                    ? <> · Sold{unit.sold_at ? ` ${stamp(unit.sold_at)}` : ''}</>
                    : ' · In stock'}
                </small>
              </button>
              <div className="app-cost-entry">
                <input
                  inputMode="decimal"
                  autoComplete="off"
                  enterKeyHint="done"
                  placeholder="0.00"
                  aria-label={`Cost for SKU ${unit.sku}`}
                  aria-invalid={rowError?.sku === unit.sku || undefined}
                  value={vals[unit.sku] || ''}
                  onChange={event => {
                    setVals(prev => ({ ...prev, [unit.sku]: event.target.value }));
                    if (rowError?.sku === unit.sku) setRowError(null);
                  }}
                  onKeyDown={event => { if (event.key === 'Enter') void submit(unit.sku); }}
                />
                <button type="button" disabled={saving === unit.sku} onClick={() => void submit(unit.sku)}>
                  {saving === unit.sku ? 'Saving…' : 'Submit'}
                </button>
              </div>
            </div>
            {rowError?.sku === unit.sku && <p className="app-cost-error" role="alert">{rowError.message}</p>}
          </div>
        ))}
        {!loading && rows && rows.length === 0 && (
          <div className="app-empty-row">{error ? 'Couldn’t load missing costs.' : 'Every listed item has a cost.'}</div>
        )}
      </div>
      <div className="app-footer-count">
        {rows == null ? '' : `${rows.length} ${rows.length === 1 ? 'unit' : 'units'} missing a cost`}
      </div>
      {rows != null && rows.length > PAGE_SIZE && (
        <div className="app-actions" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button>
          <button type="button" disabled={offset + PAGE_SIZE >= rows.length || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button>
        </div>
      )}
    </>
  );
}
