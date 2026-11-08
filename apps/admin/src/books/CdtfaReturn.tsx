import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fillCdtfaPdf } from './cdtfaPdf';

type Sale = {
  id: number; sold_on: string; sku: string; title: string; channel: string;
  measure_cents: number; tax_cents: number; ship: string | null; bucket: string; kind?: string;
};
type Line = { id: string; label: string; dollars: number; cents: number | null; note: string; sales: Sale[] };
type Check = { id: string; ok: boolean; detail: string; sales?: Sale[] };
type Doc = {
  form: string; frequency: 'monthly' | 'quarterly' | 'yearly';
  period_start: string; period_end: string; due_on: string; due_note: string;
  open: boolean; locked: boolean; legacy_lock: boolean; ready: boolean; place: string;
  lines: Line[]; checks: Check[];
  schedule_a2: { a1: number; a2: number; a4: number; note: string };
  signer: { preparer: string };
};

type Props = { client: SupabaseClient; money: (cents: number) => string; monthStart: string };

const FREQUENCIES = [
  ['monthly', 'Monthly'],
  ['quarterly', 'Quarterly'],
  ['yearly', 'Yearly'],
] as const;

function pad(n: number) { return String(n).padStart(2, '0'); }
function lastDay(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
export function filingBounds(monthStart: string, frequency: 'monthly' | 'quarterly' | 'yearly') {
  const [year, month] = monthStart.slice(0, 7).split('-').map(Number);
  if (frequency === 'yearly') return { start: `${year}-01-01`, end: `${year}-12-31` };
  if (frequency === 'monthly') return { start: `${year}-${pad(month)}-01`, end: lastDay(year, month) };
  const startMonth = Math.floor((month - 1) / 3) * 3 + 1;
  return { start: `${year}-${pad(startMonth)}-01`, end: lastDay(year, startMonth + 2) };
}
function pretty(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function dollars(n: number) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US')}.00`;
}

export function CdtfaReturn({ client, money, monthStart }: Props) {
  const [frequency, setFrequency] = useState<Doc['frequency']>('quarterly');
  const [doc, setDoc] = useState<Doc | null>(null);
  const [openId, setOpenId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bounds = filingBounds(monthStart, frequency);

  const load = useCallback(async () => {
    setError('');
    const filing = await client.rpc('portal_cdtfa_filing');
    if (filing.error) { setError(filing.error.message); return; }
    const next = (filing.data as Doc['frequency']) || 'quarterly';
    setFrequency(next);
    const period = filingBounds(monthStart, next);
    const result = await client.rpc('portal_cdtfa_return', { p_start: period.start, p_end: period.end });
    if (result.error) { setError(result.error.message); setDoc(null); return; }
    setDoc(result.data as Doc);
  }, [client, monthStart]);

  useEffect(() => { void load(); }, [load]);

  async function choose(next: Doc['frequency']) {
    setBusy(true); setError('');
    const saved = await client.rpc('portal_set_cdtfa_filing', { p_frequency: next });
    setBusy(false);
    if (saved.error) { setError(saved.error.message); return; }
    setFrequency(next);
    const period = filingBounds(monthStart, next);
    const result = await client.rpc('portal_cdtfa_return', { p_start: period.start, p_end: period.end });
    if (result.error) { setError(result.error.message); return; }
    setDoc(result.data as Doc);
  }

  async function downloadPdf() {
    if (!doc) return;
    setBusy(true); setError('');
    try {
      const bytes = await fillCdtfaPdf(doc);
      const blob = new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `CDTFA-401-A-${doc.period_start}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not fill the CDTFA form.');
    } finally { setBusy(false); }
  }

  function printSheet() {
    document.body.classList.add('cdtfa-printing');
    window.print();
    window.setTimeout(() => document.body.classList.remove('cdtfa-printing'), 500);
  }

  const shownStart = doc?.period_start || bounds.start;
  const shownEnd = doc?.period_end || bounds.end;
  const periodEnded = shownEnd < new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  return (
    <section className="cdtfa-sheet">
      <header className="cdtfa-head">
        <p className="cdtfa-kicker">CDTFA-401-A · REV. 126 (1-26)</p>
        <h2>Sales tax return</h2>
        <p>{pretty(shownStart)} – {pretty(shownEnd)}</p>
        <p className="cdtfa-due">Due on or before <strong>{doc ? pretty(doc.due_on) : '…'}</strong></p>
        <p className="cdtfa-note">{doc?.due_note || 'Floor prepares this worksheet. A person files it. Floor does not store a CDTFA login.'}</p>
      </header>
      <div className="cdtfa-freq" role="group" aria-label="Filing frequency">
        {FREQUENCIES.map(([id, label]) => (
          <button key={id} type="button" className={frequency === id ? 'on' : ''} disabled={busy} onClick={() => void choose(id)}>{label}</button>
        ))}
      </div>
      {error && <p className="cdtfa-bad" role="alert">{error}</p>}
      {doc && (
        <>
          <p className={doc.ready ? 'cdtfa-status' : 'cdtfa-status cdtfa-bad'}>
            {doc.ready ? 'Ready to review' : doc.open ? 'Not ready — this period is still open' : 'Not ready'}
            {doc.locked ? ' · Locked with Books' : ''}
            {doc.legacy_lock ? ' · A locked month was saved before this worksheet existed, so those sales are read from the ledger.' : ''}
          </p>
          <ul className="cdtfa-checks">
            {doc.checks.map((check) => (
              <li key={check.id} className={check.ok ? '' : 'cdtfa-bad'}>
                {check.detail}
                {(check.sales || []).length > 0 && (
                  <ul className="cdtfa-sales">
                    {check.sales!.map((sale, index) => (
                      <li key={`${sale.id}-${index}`}>
                        <span>{sale.title}<small>{sale.sold_on} · SKU {sale.sku} · {sale.channel}{sale.ship ? ` · ${sale.ship}` : ''}{sale.bucket === 'missing_state' ? ' · ship-to state missing' : ''}{check.id === 'collected' ? ` · tax ${money(sale.tax_cents)}` : ''}</small></span>
                        <b>{money(sale.measure_cents)}</b>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          <p className="cdtfa-note">{doc.place}</p>
          <div className="cdtfa-lines">
            {doc.lines.map((row) => {
              const sales = row.sales || [];
              const opened = openId === row.id;
              return (
                <div key={row.id} className="cdtfa-line">
                  <button type="button" className="cdtfa-line-main" onClick={() => sales.length && setOpenId(opened ? '' : row.id)} aria-expanded={opened}>
                    <span className="cdtfa-id">{row.id}</span>
                    <span>
                      <strong>{row.label}</strong>
                      <small>{row.note}{row.cents != null ? ` Cent total ${money(row.cents)}.` : ''}</small>
                    </span>
                    <b>{dollars(row.dollars)}</b>
                  </button>
                  {opened && (
                    <ul className="cdtfa-sales">
                      {sales.map((sale, index) => (
                        <li key={`${sale.id}-${index}`} className={sale.bucket === 'missing_state' ? 'cdtfa-bad' : ''}>
                          <span>{sale.title}<small>{sale.sold_on} · SKU {sale.sku} · {sale.channel}{sale.ship ? ` · ${sale.ship}` : ''}{sale.bucket === 'missing_state' ? ' · ship-to state missing' : ''}</small></span>
                          <b>{money(sale.measure_cents)}</b>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
          <section className="cdtfa-a2">
            <h3>Schedule A2 — district tax</h3>
            <p>A1 taxable transactions {dollars(doc.schedule_a2.a1)}</p>
            <p>A2/A3 subject only to 7.25% {dollars(doc.schedule_a2.a2)}</p>
            <p>A4 subject to district tax {dollars(doc.schedule_a2.a4)}</p>
            <p className="cdtfa-note">{doc.schedule_a2.note}</p>
          </section>
          <section className="cdtfa-sign">
            <h3>Signature</h3>
            <p className="cdtfa-note">Left blank for Steve. Type them here to print. Floor does not save them.</p>
            <label>Name<input aria-label="Signer name" /></label>
            <label>Title<input aria-label="Signer title" /></label>
            <label>Date<input aria-label="Signer date" /></label>
            <label>Email<input aria-label="Signer email" /></label>
            <label>Phone<input aria-label="Signer phone" /></label>
            <p>Preparer <strong>{doc.signer.preparer}</strong></p>
            <p className="cdtfa-note">Account number stays blank. It is on the CDTFA letter, and Floor does not store it.</p>
          </section>
          <div className="cdtfa-actions">
            <button type="button" onClick={printSheet}>Print worksheet</button>
            <button type="button" onClick={() => void downloadPdf()} disabled={busy}>Download filled CDTFA-401-A</button>
          </div>
          <p className="cdtfa-note">The download is the official CDTFA-401-A REV. 126 with the dollar lines filled in. The signature is blank. This is not a filing. {periodEnded ? 'This filing period has ended.' : 'This filing period is still open.'}</p>
        </>
      )}
    </section>
  );
}
