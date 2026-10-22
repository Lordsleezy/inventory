import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type SaleTaxRow = {
  id: number;
  sold_at: string;
  channel: string;
  sku: string;
  title: string;
  price_cents: number;
  sales_tax_cents: number;
  sales_tax_who: 'marketplace' | 'store' | 'none' | string;
  sales_tax_owed_cents: number;
};

type TaxPayment = { id: string; spent_on: string; description: string; amount_cents: number };

type Props = { client: SupabaseClient; money: (n: number) => string; stamp: (s: string) => string };

const zone = 'America/Los_Angeles';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: zone });
const monthStart = () => `${today().slice(0, 7)}-01`;
const moneyEntry = /^\d*(?:\.\d{0,2})?$/;
const SALES_TAX_CATEGORY = 'Sales tax';

export function TaxPage({ client, money, stamp }: Props) {
  const [start, setStart] = useState(monthStart);
  const [end, setEnd] = useState(today);
  const [rows, setRows] = useState<SaleTaxRow[] | null>(null);
  const [taxPaid, setTaxPaid] = useState<TaxPayment[]>([]);
  const [paidAmount, setPaidAmount] = useState('');
  const [paidDate, setPaidDate] = useState(today);
  const [paidNote, setPaidNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadPayments = useCallback(async () => {
    const { data, error: e } = await client
      .from('portal_expenses')
      .select('id, spent_on, description, amount_cents, voided_at, category')
      .eq('category', SALES_TAX_CATEGORY)
      .is('voided_at', null)
      .gte('spent_on', start)
      .lte('spent_on', end)
      .order('spent_on', { ascending: false });
    if (e) { setError(e.message); return; }
    setTaxPaid((data || []) as TaxPayment[]);
  }, [client, start, end]);

  const load = useCallback(async () => {
    setError('');
    const { data, error: e } = await client.rpc('portal_sale_tax_rows', { p_start: start, p_end: end });
    if (e) { setError(e.message); setRows(null); return; }
    const body = data as { rows?: SaleTaxRow[] };
    // In-person (floor) only — marketplaces remit their own sales tax.
    const floor = (body?.rows || []).filter(r => (r.channel || '').toLowerCase() === 'floor');
    setRows(floor);
    await loadPayments();
  }, [client, start, end, loadPayments]);

  useEffect(() => { void load(); }, [load]);

  async function recordTaxPaid(ev: React.FormEvent) {
    ev.preventDefault();
    const cents = Math.round(Number(paidAmount || 0) * 100);
    if (!Number.isFinite(cents) || cents <= 0) { setError('Enter a sales tax payment amount.'); return; }
    if (!paidDate) { setError('Choose a payment date.'); return; }
    setBusy(true); setError('');
    const { error: e } = await client.rpc('portal_add_expense', {
      p_spent_on: paidDate,
      p_description: paidNote.trim() || 'Sales tax payment',
      p_category: SALES_TAX_CATEGORY,
      p_amount_cents: cents,
      p_needs_reimbursement: false,
      p_employee: null,
    });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setPaidAmount('');
    setPaidNote('');
    await loadPayments();
  }

  async function removeTaxPaid(id: string) {
    if (!window.confirm('Remove this sales tax payment?')) return;
    setBusy(true); setError('');
    const { error: e } = await client.rpc('portal_delete_expense', { p_id: id });
    setBusy(false);
    if (e) setError(e.message);
    else await loadPayments();
  }

  const totals = useMemo(() => {
    const list = rows || [];
    const paid = taxPaid.reduce((n, p) => n + (p.amount_cents || 0), 0);
    const owed = list.reduce((n, r) => n + (r.sales_tax_owed_cents || r.sales_tax_cents || 0), 0);
    return {
      salesTaxOwed: owed,
      salesTaxPaid: paid,
      salesTaxBalance: owed - paid,
      salesCount: list.length,
    };
  }, [rows, taxPaid]);

  return <>
    <header>
      <div>
        <div className="eyebrow">TAX LEDGER</div>
        <h1>Sales tax</h1>
        <p>In-person sales tax the store remits. Marketplace sales (eBay, Depop, etc.) are not tracked here — those channels remit for you.</p>
      </div>
      <div className="report-actions">
        <label className="date-control">From<input type="date" value={start} onChange={e => setStart(e.target.value || monthStart())} /></label>
        <label className="date-control">To<input type="date" value={end} onChange={e => setEnd(e.target.value || today())} /></label>
        <div className="actions">
          <button className="secondary" onClick={() => void load()}>Refresh</button>
        </div>
      </div>
    </header>
    {error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}

    <div className="stats">
      <div className="stat"><span>Sales tax we owe</span><strong>{money(totals.salesTaxOwed)}</strong></div>
      <div className="stat"><span>Tax paid</span><strong>{money(totals.salesTaxPaid)}</strong></div>
      <div className="stat"><span>Balance remaining</span><strong>{money(totals.salesTaxBalance)}</strong></div>
    </div>

    <section className="panel">
      <div className="section-head">
        <div>
          <div className="eyebrow">PAYMENTS</div>
          <h2>Sales tax paid</h2>
          <p className="hint" style={{ margin: 0 }}>Record CDTFA / state payments against tax we owe for this date range.</p>
        </div>
      </div>
      <form className="payment-form" onSubmit={e => void recordTaxPaid(e)} style={{ marginBottom: 12 }}>
        <label>Amount paid
          <input type="text" inputMode="decimal" value={paidAmount}
            onChange={e => { if (moneyEntry.test(e.target.value)) setPaidAmount(e.target.value); }}
            placeholder="0.00" required />
        </label>
        <label>Date
          <input type="date" value={paidDate} onChange={e => setPaidDate(e.target.value || today())} required />
        </label>
        <label className="payment-note">Note
          <input type="text" value={paidNote} onChange={e => setPaidNote(e.target.value.slice(0, 200))} placeholder="Optional — e.g. Q3 filing" />
        </label>
        <button disabled={busy || !paidAmount}>{busy ? 'Saving…' : 'Record payment'}</button>
      </form>
      {taxPaid.length === 0 ? <p className="hint">No sales tax payments in this range yet.</p>
        : <div className="ledger-list">{taxPaid.map(p => (
          <div className="ledger-row" key={p.id}>
            <div><strong>{p.spent_on}</strong><span>{p.description}</span></div>
            <b>{money(p.amount_cents)}</b>
            <button type="button" className="text-button" disabled={busy} onClick={() => void removeTaxPaid(p.id)}>Remove</button>
          </div>
        ))}</div>}
    </section>

    <section className="panel">
      <div className="section-head"><div><div className="eyebrow">IN PERSON</div><h2>Sales tax by sale</h2></div></div>
      {rows === null ? <p className="hint">Loading…</p>
        : rows.length === 0 ? <div className="empty">No in-person sales with tax in this range.</div>
        : <div className="table-wrap"><table className="tbl">
          <thead>
            <tr>
              <th>When</th><th>Item</th>
              <th className="n">Sale</th><th className="n">Sales tax</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{stamp(r.sold_at)}</td>
                <td>{r.title} <span className="tag">SKU {r.sku}</span></td>
                <td className="n">{money(r.price_cents)}</td>
                <td className="n">{money(r.sales_tax_owed_cents || r.sales_tax_cents || 0)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>}
      <p className="hint">{totals.salesCount} in-store sale{totals.salesCount === 1 ? '' : 's'} in range. Online marketplace tax is not included.</p>
    </section>
  </>;
}
