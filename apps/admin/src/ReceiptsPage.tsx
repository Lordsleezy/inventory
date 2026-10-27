import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';

type Line = {
  id: number; sku: string; title: string; condition: string | null; qty: number;
  price_cents: number; tax_cents: number; card_fee_cents: number; list_price_cents: number | null;
};
type Receipt = {
  ticket_key: string; receipt_no: string; sold_at: string; channel: string;
  payment_method: string | null; card_brand: string | null; card_last4: string | null;
  cash_cents: number | null; card_cents: number | null; actor_name: string | null;
  buyer_name: string | null; buyer_email: string | null; order_no: string | null;
  subtotal_cents: number; tax_cents: number; card_fee_cents: number; total_cents: number;
  shipping_cents: number; fee_cents?: number; label_cents?: number;
  processing_cents?: number; cost_cents?: number; profit_cents?: number;
  needs_sku?: boolean;
  lines: Line[];
};
type Financial = { sale_id: number; price_cents: number; shipping_cents: number; tax_cents: number; fee_cents: number; label_cents: number; other_charge_cents: number; cost_cents: number | null };
type EditRevision = { actor_id: string | null; created_at: string; old_values: Record<string, number | null>; new_values: Record<string, number | null>; commission_delta: Record<string, unknown> };

const LEGAL =
  '7-DAY EXCHANGE ONLY. No returns and no refunds. With this receipt, you may exchange the item or take store credit within 7 days of sale. Goods are sold AS-IS, WHERE-IS, with all faults. Keep this receipt.';

const CHANNEL: Record<string, string> = {
  floor: 'In person', website: 'Website', ebay: 'eBay', depop: 'Depop',
  amazon: 'Amazon', whatnot: 'Whatnot', mercari: 'Mercari', facebook: 'Facebook',
};

function isOnline(channel: string) {
  const ch = (channel || '').toLowerCase();
  return ch !== 'floor';
}

function feeName(channel: string) {
  const ch = (channel || '').toLowerCase();
  if (ch === 'ebay') return 'eBay fees';
  if (ch === 'depop') return 'Depop fees';
  if (ch === 'amazon') return 'Amazon fees';
  return 'Marketplace fees';
}

function tender(r: Receipt) {
  const ch = (r.channel || '').toLowerCase();
  if (ch !== 'floor' && ch !== 'website') return CHANNEL[ch] || ch;
  const method = (r.payment_method || 'other').toUpperCase();
  const card = [r.card_brand, r.card_last4 ? `•••• ${r.card_last4}` : null].filter(Boolean).join(' ');
  if (method === 'SPLIT') {
    const parts = ['SPLIT'];
    if (r.cash_cents != null) parts.push(`cash $${(r.cash_cents / 100).toFixed(2)}`);
    parts.push(`${card || 'card'}${r.card_cents != null ? ` $${(r.card_cents / 100).toFixed(2)}` : ''}`);
    return parts.join(' · ');
  }
  return `${method}${card ? ` · ${card}` : ''}`;
}

function depositCents(r: Receipt) {
  if (!isOnline(r.channel) || (r.channel || '').toLowerCase() === 'website') {
    return r.total_cents - (r.processing_cents || 0);
  }
  return r.subtotal_cents + (r.shipping_cents || 0) - (r.fee_cents || 0) - (r.label_cents || 0);
}

function row(label: string, value: string, strong = false) {
  return <div className={strong ? 'receipt-row receipt-total' : 'receipt-row'}><span>{label}</span><b>{value}</b></div>;
}

function actorLabel(channel: string, name: string | null) {
  if (isOnline(channel)) return name && name !== 'Admin' && name !== 'service' ? name : 'Online';
  if (!name || name === 'Admin' || name === 'service' || name === 'Unknown') return 'Unassigned';
  return name;
}

function ReceiptDoc({ r, money, stamp }: { r: Receipt; money: (n: number) => string; stamp: (s: string) => string }) {
  const online = isOnline(r.channel);
  const marketplace = online && (r.channel || '').toLowerCase() !== 'website';
  const channel = CHANNEL[(r.channel || '').toLowerCase()] || r.channel;
  const buyer = [r.buyer_name, r.buyer_email].filter(Boolean).join(' · ');
  const deposit = depositCents(r);
  const who = actorLabel(r.channel, r.actor_name);

  return <div className="receipt-sheet">
    <h1>Open Box Industries</h1>
    <p className="receipt-meta">
      Receipt {r.receipt_no} · {stamp(r.sold_at)}<br />
      {channel} · {who}
      {buyer ? <><br />{buyer}</> : null}
      {r.order_no ? <><br />Order {r.order_no}</> : null}
    </p>
    <table className="receipt-items">
      <tbody>
        {r.lines.map(l => (
          <tr key={l.id}>
            <td>
              <strong>{l.qty > 1 ? `${l.qty}├ù ` : ''}{l.title || 'Item'}</strong>
              <small>SKU {l.sku}{l.condition ? ` · ${l.condition}` : ''}</small>
            </td>
            <td>{money(l.price_cents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <div className="receipt-totals">
      {row('Item', money(r.subtotal_cents))}
      {marketplace && (r.shipping_cents || 0) > 0 && row('Buyer shipping', money(r.shipping_cents))}
      {!marketplace && (r.tax_cents || 0) > 0 && row('Sales tax', money(r.tax_cents))}
      {!marketplace && (r.card_fee_cents || 0) > 0 && row('Card surcharge', money(r.card_fee_cents))}
      {marketplace && (r.fee_cents || 0) > 0 && row(feeName(r.channel), `−${money(r.fee_cents || 0)}`)}
      {marketplace && (r.label_cents || 0) > 0 && row('Shipping label', `−${money(r.label_cents || 0)}`)}
      {!marketplace && (r.processing_cents || 0) > 0 && row('Card fees', `−${money(r.processing_cents || 0)}`)}
      {marketplace
        ? row('Net deposit', money(deposit), true)
        : row('Total collected', money(r.total_cents), true)}
      {marketplace && (r.cost_cents || 0) > 0 && row('Item cost', `−${money(r.cost_cents || 0)}`)}
      {marketplace && r.profit_cents != null && row('Profit', money(r.profit_cents || 0))}
      <div className="receipt-row"><span>{marketplace ? 'Channel' : 'Paid'}</span><b>{tender(r)}</b></div>
    </div>
    <p className="receipt-legal">{LEGAL}</p>
  </div>;
}

function printReceipt(r: Receipt, money: (n: number) => string, stamp: (s: string) => string) {
  const host = document.createElement('div');
  host.className = 'receipt-print-root';
  document.body.appendChild(host);
  const root = document.createElement('div');
  host.appendChild(root);
  // Render via innerHTML snapshot of a temporary mount isn't ideal with React;
  // build a simple print HTML string instead.
  const online = isOnline(r.channel);
  const marketplace = online && (r.channel || '').toLowerCase() !== 'website';
  const channel = CHANNEL[(r.channel || '').toLowerCase()] || r.channel;
  const buyer = [r.buyer_name, r.buyer_email].filter(Boolean).join(' · ');
  const deposit = depositCents(r);
  const esc = (t: string) => String(t || '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  const items = r.lines.map(l => `<tr><td><strong>${esc((l.qty > 1 ? `${l.qty}├ù ` : '') + (l.title || 'Item'))}</strong><div style="color:#666;font-size:12px">SKU ${esc(l.sku)}${l.condition ? ` · ${esc(l.condition)}` : ''}</div></td><td style="text-align:right">${esc(money(l.price_cents))}</td></tr>`).join('');
  const line = (label: string, value: string, bold = false) =>
    `<div style="display:flex;justify-content:space-between${bold ? ';font-weight:700;font-size:18px;margin-top:4px' : ''}"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
  const totals = [
    line('Item', money(r.subtotal_cents)),
    marketplace && (r.shipping_cents || 0) > 0 ? line('Buyer shipping', money(r.shipping_cents)) : '',
    !marketplace && (r.tax_cents || 0) > 0 ? line('Sales tax', money(r.tax_cents)) : '',
    !marketplace && (r.card_fee_cents || 0) > 0 ? line('Card surcharge', money(r.card_fee_cents)) : '',
    marketplace && (r.fee_cents || 0) > 0 ? line(feeName(r.channel), `−${money(r.fee_cents || 0)}`) : '',
    marketplace && (r.label_cents || 0) > 0 ? line('Shipping label', `−${money(r.label_cents || 0)}`) : '',
    !marketplace && (r.processing_cents || 0) > 0 ? line('Card fees', `−${money(r.processing_cents || 0)}`) : '',
    marketplace ? line('Net deposit', money(deposit), true) : line('Total collected', money(r.total_cents), true),
    marketplace && (r.cost_cents || 0) > 0 ? line('Item cost', `−${money(r.cost_cents || 0)}`) : '',
    marketplace && r.profit_cents != null ? line('Profit', money(r.profit_cents || 0)) : '',
    line(marketplace ? 'Channel' : 'Paid', tender(r)),
  ].filter(Boolean).join('');
  const html = `<!doctype html><html><head><title>Receipt ${esc(r.receipt_no)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;color:#111;max-width:480px;margin:24px auto;padding:0 16px}
h1{margin:0;font-size:22px}.muted{color:#666;font-size:12px}table{width:100%;border-collapse:collapse;margin-top:8px}
td{padding:6px 0;vertical-align:top}.box{border-top:1px solid #ccc;margin-top:14px;padding-top:12px;display:grid;gap:4px}
.legal{color:#555;font-size:12px;margin-top:22px}</style></head><body>
<h1>Open Box Industries</h1>
<p class="muted">Receipt ${esc(r.receipt_no)} · ${esc(stamp(r.sold_at))}<br/>${esc(channel)} · ${esc(actorLabel(r.channel, r.actor_name))}${buyer ? `<br/>${esc(buyer)}` : ''}${r.order_no ? `<br/>Order ${esc(r.order_no)}` : ''}</p>
<table>${items}</table><div class="box">${totals}</div>
<p class="legal">${esc(LEGAL)}</p>
<script>window.onload=function(){window.print();}</script>
</body></html>`;
  document.body.removeChild(host);
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) { document.body.removeChild(iframe); return false; }
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => { try { document.body.removeChild(iframe); } catch { /* ignore */ } }, 60_000);
  return true;
}

export function ReceiptsPage({ client, money, stamp }: {
  client: SupabaseClient; money: (n: number) => string; stamp: (s: string) => string;
}) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Receipt[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<'all' | 'instore' | 'online'>('all');
  const [viewing, setViewing] = useState<Receipt | null>(null);
  const [editLine, setEditLine] = useState<Line | null>(null);
  const [financial, setFinancial] = useState<Financial | null>(null);
  const [history, setHistory] = useState<EditRevision[]>([]);
  const [saving, setSaving] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const limit = 50;

  const load = useCallback(async (q: string, off: number) => {
    setBusy(true); setError('');
    try {
      const { data, error: e } = await client.rpc('portal_receipts', {
        p_query: q.trim() || null, p_limit: limit, p_offset: off,
      });
      if (e) throw e;
      const payload = data as { total: number; rows: Receipt[] };
      setTotal(payload?.total || 0);
      setRows(payload?.rows || []);
    } catch (e) {
      setError(errText(e) || 'Could not load receipts.');
    }
    finally { setBusy(false); }
  }, [client]);

  useEffect(() => {
    const t = setTimeout(() => void load(query, offset), 200);
    return () => clearTimeout(t);
  }, [load, query, offset]);

  const shown = rows.filter(r => {
    const date = r.sold_at.slice(0, 10);
    if (startDate && date < startDate) return false;
    if (endDate && date > endDate) return false;
    const floor = (r.channel || '').toLowerCase() === 'floor';
    if (scope === 'instore') return floor;
    if (scope === 'online') return !floor;
    return true;
  });

  async function beginEdit(line: Line) {
    setEditLine(line); setFinancial(null); setHistory([]); setError('');
    const [{ data, error: detailsError }, { data: revisions, error: historyError }] = await Promise.all([
      client.rpc('portal_sale_financial_details', { p_sale_id: line.id }),
      client.rpc('portal_sale_edit_history', { p_sale_id: line.id }),
    ]);
    if (detailsError || historyError) { setError((detailsError || historyError)?.message || 'Could not load sale details.'); return; }
    setFinancial(data as Financial); setHistory((revisions || []) as EditRevision[]);
  }

  async function saveFinancial(event: FormEvent) {
    event.preventDefault(); if (!financial || saving) return;
    setSaving(true); setError('');
    try {
      const { error: saveError } = await client.rpc('portal_edit_sale_financials', {
        p_sale_id: financial.sale_id, p_price_cents: financial.price_cents, p_shipping_cents: financial.shipping_cents,
        p_tax_cents: financial.tax_cents, p_fee_cents: financial.fee_cents, p_label_cents: financial.label_cents,
        p_other_charge_cents: financial.other_charge_cents, p_cost_cents: financial.cost_cents,
      });
      if (saveError) throw saveError;
      setEditLine(null); setFinancial(null); await load(query, offset);
      if (viewing) setViewing(null);
    } catch (e) { setError(errText(e) || 'Could not save receipt changes.'); }
    finally { setSaving(false); }
  }

  return <>
    <header>
      <div>
        <div className="eyebrow">SALES HISTORY</div>
        <h1>Receipts</h1>
        <p>Every purchase — in person and online. View in the browser or print.</p>
      </div>
    </header>
    <div className="inventory-controls">
      <label>Search
        <input type="search" placeholder="Receipt #, SKU, buyer, channel…"
          value={query} onChange={e => { setQuery(e.target.value); setOffset(0); }} />
      </label>
      <label>From<input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></label>
      <label>Through<input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} /></label>
      <div className="actions" style={{ alignSelf: 'end' }}>
        <button type="button" className={scope === 'all' ? undefined : 'secondary'} onClick={() => setScope('all')}>All</button>
        <button type="button" className={scope === 'instore' ? undefined : 'secondary'} onClick={() => setScope('instore')}>In person</button>
        <button type="button" className={scope === 'online' ? undefined : 'secondary'} onClick={() => setScope('online')}>Online</button>
      </div>
    </div>
    {error && <div className="alert" role="alert">{error}</div>}
    <div className="stats inventory-stats inventory-stats-one">
      <div className="stat"><span>Receipts</span><strong>{scope === 'all' ? total : shown.length}{scope !== 'all' ? ' shown' : ''}</strong></div>
    </div>
    <section className="panel">
      {busy && rows.length === 0 && <p className="hint">Loading receipts…</p>}
      {!busy && shown.length === 0 && <div className="empty">No receipts match.</div>}
      <div className="ticket-list">
        {shown.map(r => {
          const floor = (r.channel || '').toLowerCase() === 'floor';
          const label = CHANNEL[(r.channel || '').toLowerCase()] || r.channel;
          const marketplace = !floor && (r.channel || '').toLowerCase() !== 'website';
          const displayTotal = marketplace ? depositCents(r) : r.total_cents;
          const title = r.lines.map(l => l.title).filter(Boolean).slice(0, 2).join(' · ')
            + (r.lines.length > 2 ? ` +${r.lines.length - 2} more` : '');
          return <div className="ticket" key={r.ticket_key}>
            <div className="ticket-top">
              <strong>{money(displayTotal)}
                <small className="ticket-profit"> · {r.lines.length} item{r.lines.length === 1 ? '' : 's'}{marketplace ? ' · net deposit' : ''}{r.needs_sku ? ' · needs SKU' : ''}</small>
              </strong>
              <span>{stamp(r.sold_at)}<b className="badge"> {(label || '').toUpperCase()}</b>{r.needs_sku ? <b className="badge"> UNMATCHED</b> : null}</span>
            </div>
            <div className="ticket-items"><div><strong>{title || 'Sale'}</strong>
              <small> · Receipt {r.receipt_no}{r.order_no && r.order_no !== r.receipt_no ? ` · Order ${r.order_no}` : ''}
                {r.buyer_name ? ` · ${r.buyer_name}` : floor ? ` · ${actorLabel(r.channel, r.actor_name)}` : ''}
              </small>
            </div></div>
            <div className="ticket-bottom">
              <span>{tender(r)}{(r.fee_cents || 0) > 0 ? ` · fees ${money(r.fee_cents || 0)}` : ''}{(r.label_cents || 0) > 0 ? ` · label ${money(r.label_cents || 0)}` : ''}</span>
              <span className="actions">
                <button type="button" className="secondary" onClick={() => setViewing(r)}>View</button>
                <button type="button" onClick={() => { if (!printReceipt(r, money, stamp)) setError('Could not open print dialog.'); }}>Print</button>
              </span>
            </div>
          </div>;
        })}
      </div>
    </section>
    {scope === 'all' && total > limit && <div className="inventory-pagination">
      <button type="button" className="secondary" disabled={offset === 0 || busy} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</button>
      <span>{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
      <button type="button" className="secondary" disabled={offset + limit >= total || busy} onClick={() => setOffset(offset + limit)}>Next</button>
    </div>}
    {viewing && <div className="inventory-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setViewing(null); }}>
        <section className="inventory-detail receipt-viewer" role="dialog" aria-modal="true" aria-label={`Receipt ${viewing.receipt_no}`}>
        <div className="section-head">
          <div><div className="eyebrow">RECEIPT</div><h2>{viewing.receipt_no}</h2></div>
          <div className="actions">
            <button type="button" onClick={() => { printReceipt(viewing, money, stamp); }}>Print</button>
            <button type="button" className="secondary" onClick={() => setViewing(null)}>Close</button>
          </div>
        </div>
        <ReceiptDoc r={viewing} money={money} stamp={stamp} />
        <section className="receipt-edit-lines"><h3>Edit sale details</h3><p>Changes recalculate the sale ledger. Paid commission is preserved; increases are recorded as payout adjustments.</p>
          {viewing.lines.filter(line => line.id > 0).map(line => <button type="button" className="secondary" key={line.id} onClick={() => void beginEdit(line)}>Edit SKU {line.sku} · {line.title}</button>)}
        </section>
      </section>
    </div>}
    {editLine && <div className="inventory-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !saving) setEditLine(null); }}>
      <section className="inventory-detail receipt-edit-dialog" role="dialog" aria-modal="true" aria-label={`Edit sale SKU ${editLine.sku}`}>
        <div className="section-head"><div><div className="eyebrow">SALE FINANCIALS</div><h2>SKU {editLine.sku}</h2></div><button type="button" className="secondary" disabled={saving} onClick={() => setEditLine(null)}>Close</button></div>
        {!financial ? <p>Loading sale details…</p> : <form className="receipt-financial-form" onSubmit={event => void saveFinancial(event)}>
          {([['price_cents','Sale price'],['shipping_cents','Buyer-paid shipping'],['fee_cents','Fees'],['tax_cents','Sales tax'],['label_cents','Shipping label'],['other_charge_cents','Other charge'],['cost_cents','Cost']] as const).map(([key,label]) => <label key={key}>{label} ($)<input type="number" min="0" step="0.01" value={financial[key] == null ? '' : (financial[key]! / 100).toFixed(2)} onChange={e => { const cents = e.target.value === '' && key === 'cost_cents' ? null : Math.round(Number(e.target.value || 0) * 100); setFinancial({ ...financial, [key]: cents } as Financial); }} /></label>)}
          <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save sale changes'}</button>
          <h3>Edit history</h3>{history.length ? history.map((revision,index) => <div className="receipt-revision" key={index}><strong>{stamp(revision.created_at)} · {revision.actor_id || 'Unknown admin'}</strong>{Object.keys(revision.new_values || {}).map(key => <small key={key}>{key.replaceAll('_',' ')}: {revision.old_values?.[key] == null ? '—' : money(revision.old_values[key]!)} → {revision.new_values?.[key] == null ? '—' : money(revision.new_values[key]!)}</small>)}{Object.keys(revision.commission_delta || {}).length > 0 && <small>Commission changes: {JSON.stringify(revision.commission_delta)}</small>}</div>) : <p>No prior edits.</p>}
        </form>}
      </section>
    </div>}
  </>;
}
