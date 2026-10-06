import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

const base = (import.meta.env.VITE_FLOOR_FUNCTIONS_URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');
const channels = [['ebay', 'eBay'], ['mercari', 'Mercari'], ['whatnot', 'Whatnot'], ['depop', 'Depop'], ['website', 'Website']] as const;
type Pricing = {
  sku: string; floor_cents: number; label_estimate_cents: number; label_is_estimate: boolean;
  missing_package_data: boolean; packing_markup_cents: number; global_packing_markup_cents: number;
  unit_packing_markup_cents: number | null; prices: Record<string, number>;
};
type Props = { sku: string; accessToken: string; client: SupabaseClient; money: (cents: number) => string };

export function MarketplacePrices({ sku, accessToken, client, money }: Props) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Pricing | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  async function load() {
    setError('');
    try {
      const res = await fetch(`${base}/api/marketplace-prices?sku=${encodeURIComponent(sku)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `Price request failed (${res.status})`);
      setData(result);
      setDraft(result.unit_packing_markup_cents == null ? '' : (result.unit_packing_markup_cents / 100).toFixed(2));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => { if (open && !data) void load(); }, [open, data]);

  async function saveOverride() {
    const value = draft.trim() === '' ? null : Math.round(Number(draft) * 100);
    if (value != null && (!Number.isFinite(value) || value < 0)) { setError('Enter a nonnegative packing amount.'); return; }
    setBusy(true); setError('');
    try {
      const { error: rpcError } = await client.rpc('portal_set_unit_marketplace_markup', { p_sku: sku, p_markup_cents: value });
      if (rpcError) throw rpcError;
      setData(null);
      setDraft(value == null ? '' : (value / 100).toFixed(2));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function copy(channel: string, cents: number) {
    try { await navigator.clipboard.writeText((cents / 100).toFixed(2)); setCopied(channel); setTimeout(() => setCopied(''), 1400); }
    catch { setError('Clipboard access is unavailable in this browser.'); }
  }

  return <details className="suggested-prices" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Suggested prices</summary>
    {error && <p className="bad-text" role="alert">{error}</p>}
    {!data ? <p className="hint">Loading pricesâ€¦</p> : <>
      <p className="hint">Floor {money(data.floor_cents)} Â· label estimate {money(data.label_estimate_cents)}
        {data.label_is_estimate ? ' (estimate)' : ''}</p>
      {data.missing_package_data && <p className="hint">Missing package dims â€” label cost is estimated.</p>}
      <div className="suggested-price-list">{channels.map(([key, label]) => <div key={key} className="suggested-price-row">
        <strong>{label}</strong><span>{money(data.prices[key])}</span>
        <button type="button" className="text-button" onClick={() => void copy(key, data.prices[key])}>{copied === key ? 'Copied' : 'Copy'}</button>
      </div>)}</div>
      <div className="suggested-price-markup">
        <label>Unit packing markup ($; blank uses global ${((data.global_packing_markup_cents || 0) / 100).toFixed(2)})
          <input inputMode="decimal" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Use global" />
        </label>
        <button type="button" disabled={busy} onClick={() => void saveOverride()}>{busy ? 'Savingâ€¦' : 'Save unit markup'}</button>
      </div>
    </>}
  </details>;
}
