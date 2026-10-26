import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';

type Sale = { id: number; receipt_no: string; sold_at: string; channel: string; qty: number; price_cents: number };
export function RestoreInventoryButton({ client, sku, onDone }: { client: SupabaseClient; sku: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [saleId, setSaleId] = useState('');
  const [reason, setReason] = useState('');
  const [present, setPresent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load() {
    setOpen(true); setSales(null); setReason(''); setPresent(false); setError('');
    const { data, error: e } = await client.rpc('portal_inventory_restore_options', { p_sku: sku });
    if (e) { setError(errText(e)); return; }
    const rows = (data?.sales || []) as Sale[];
    setSales(rows); setSaleId(rows.length === 1 ? String(rows[0].id) : '');
  }
  async function restore() {
    setBusy(true); setError('');
    try {
      const { error: e } = await client.rpc('portal_inventory_mark_not_sold', {
        p_sku: sku, p_reason: reason.trim(), p_sale_id: saleId ? Number(saleId) : null,
      });
      if (e) throw e;
      setOpen(false); onDone();
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  return <>
    <button type="button" className="secondary" onClick={() => void load()}>Not sold / return to inventory</button>
    {open && <div className="mboard-modal" role="dialog" aria-modal="true" aria-label="Return item to inventory"><div className="mboard-modal-card">
      <h2>Return SKU {sku} to inventory</h2>
      {error && <p className="alert" role="alert">{error}</p>}
      {sales === null ? <p>Loading sale history…</p> : <>
        {sales.length ? <>
          <p>This voids the selected sale in Floor and puts its quantity back in stock. Other items on the ticket stay sold.</p>
          <p>It does not refund a payment or cancel a marketplace order. Handle those separately before putting the item back up for sale.</p>
          <label>Sale to reverse<select value={saleId} onChange={e => setSaleId(e.target.value)}>
            <option value="">Choose sale</option>
            {sales.map(s => <option key={s.id} value={s.id}>{s.receipt_no} · {s.channel} · ${(s.price_cents / 100).toFixed(2)} · {new Date(s.sold_at).toLocaleDateString()} · Qty {s.qty || 1}</option>)}
          </select></label>
        </> : <p>No active sale remains. This corrects the stock status without changing canceled sales or payment history.</p>}
        <label>Reason<input value={reason} onChange={e => setReason(e.target.value)} placeholder="Canceled sale, mistaken entry, item returned…" /></label>
        <label className="inventory-check"><input type="checkbox" checked={present} onChange={e => setPresent(e.target.checked)} /> I have verified this item is physically back in stock.</label>
        <p className="hint">Channel checkboxes are cleared for review. This does not automatically relist the item.</p>
        <div className="actions"><button type="button" disabled={busy || !present || !reason.trim() || (sales.length > 0 && !saleId)} onClick={() => void restore()}>{busy ? 'Restoring…' : 'Return to inventory'}</button><button type="button" className="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button></div>
      </>}
      {sales === null && <button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button>}
    </div></div>}
  </>;
}
