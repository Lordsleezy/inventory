import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Check, Period, Report } from './types';
import { buildBooksExcel, buildBooksPdf, bytesBase64 } from './export';
import { buildBooksWorkbook } from './workbook';
import { monthLabel } from './booksMath';
import type { InventorySummary, ReceivedItem } from './types';

const SOURCES = ['safe', 'square', 'ebay', 'depop', 'website', 'amazon', 'tiktok'];
const SOURCE_LABEL: Record<string, string> = { safe: 'Safe cash', square: 'Square', ebay: 'eBay', depop: 'Depop', website: 'Website', amazon: 'Amazon', tiktok: 'TikTok' };
const asDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

type Props = {
  client: SupabaseClient;
  money: (c: number) => string;
  period: Period;
  report: Report;
  inventory: InventorySummary;
  received: ReceivedItem[];
  onReload: () => Promise<void>;
  onError: (msg: string) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
};

export function BooksClosePanel({ client, money, period, report, inventory, received, onReload, onError, busy, setBusy }: Props) {
  const [open, setOpen] = useState(false);
  const [openForm, setOpenForm] = useState(false);
  const [openSource, setOpenSource] = useState('safe');
  const [openDate, setOpenDate] = useState('');
  const [openAmount, setOpenAmount] = useState('');
  const [openNote, setOpenNote] = useState('');

  async function explain(check: Check, text: string) {
    const { error: e } = await client.rpc('portal_books_explain', { p_period: period.id, p_check_key: check.key, p_explanation: text });
    if (e) onError("Couldn't save the explanation"); else await onReload();
  }

  async function saveOpening() {
    const amount = Number(openAmount);
    if (!Number.isFinite(amount) || Math.round(amount * 100) !== amount * 100 || !openDate) { onError('Enter a date and an amount with no more than two decimal places.'); return; }
    setBusy(true);
    try {
      const { error: e } = await client.rpc('portal_books_save_opening', { p_source: openSource, p_on: openDate, p_amount_cents: Math.round(amount * 100), p_note: openNote });
      if (e) throw e;
      setOpenForm(false); setOpenAmount(''); setOpenNote('');
      await onReload();
    } catch { onError("Couldn't save this balance"); } finally { setBusy(false); }
  }

  async function capture(boundary: 'start' | 'end') {
    setBusy(true);
    try {
      const { error: e } = await client.rpc('portal_books_capture_inventory', { p_on: asDate(new Date()), p_boundary: boundary });
      if (e) throw e;
      await onReload();
    } catch { onError("Couldn't save the inventory count"); } finally { setBusy(false); }
  }

  async function finalize() {
    if (!window.confirm(`Lock ${period.period_start}–${period.period_end}? This freezes the report and blocks dated edits.`)) return;
    setBusy(true);
    try {
      const workbook = buildBooksWorkbook(report, inventory, received);
      const payload = { ...report, inventory_summary: inventory, items_received: received };
      const [excel, pdf] = await Promise.all([
        buildBooksExcel(period, workbook, `${period.period_start} Books`),
        buildBooksPdf(period, workbook, money),
      ]);
      const { error: e } = await client.rpc('portal_books_finalize', {
        p_period: period.id,
        p_report: payload,
        p_excel_base64: bytesBase64(excel),
        p_pdf_base64: bytesBase64(pdf),
      });
      if (e) throw e;
      await onReload();
    } catch { onError("Couldn't close this period"); } finally { setBusy(false); }
  }

  async function unlock() {
    const reason = window.prompt('Required reason to unlock this closed month (at least 8 characters):');
    if (!reason) return;
    const { error: e } = await client.rpc('portal_books_unlock', { p_period: period.id, p_reason: reason });
    if (e) onError("Couldn't unlock this period"); else await onReload();
  }

  const pending = (report.checks || []).filter((c) => !c.ok && !c.explanation).length;
  const locked = period.status === 'locked';

  return (
    <section className="books-close-panel">
      <button type="button" className="books-close-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Close month {locked ? '· locked' : pending ? `· ${pending} checks open` : '· ready'}
      </button>
      {open && (
        <div className="books-close-body panel">
          {locked ? (
            <div className="books-lock-footer">
              <span>Frozen report stored {period.locked_at ? new Date(period.locked_at).toLocaleString() : ''}{period.locked_by_name ? ` by ${period.locked_by_name}` : ''}</span>
              <button type="button" className="secondary" disabled={busy} onClick={() => void unlock()}>Unlock with reason</button>
            </div>
          ) : (
            <>
              <section className="books-checks">
                <h3>Close checklist · {(report.checks || []).filter((c) => c.ok || c.explanation).length} of {(report.checks || []).length} done</h3>
                {(report.checks || []).map((c) => (
                  <div className="books-check" key={c.key}>
                    <div>
                      <strong className={c.ok ? 'ok' : 'not-ok'}>{c.ok ? '✓' : '!'}</strong>
                      <span>{c.label}<small>{c.detail}{!c.ok && c.count ? ` · ${c.count} item(s)` : ''}</small></span>
                    </div>
                    {!c.ok && (
                      <label>
                        Explanation for close
                        <textarea defaultValue={c.explanation || ''} placeholder="Explain why this remains open or how it is carried forward." onBlur={(e) => { if (e.target.value.trim() && e.target.value !== c.explanation) void explain(c, e.target.value); }} />
                      </label>
                    )}
                    {c.explanation && <p className="books-explanation">{c.explanation}</p>}
                  </div>
                ))}
              </section>
              <div className="books-snapshot-actions">
                <p>Capture inventory snapshots on period boundaries for accurate month-start/end counts.</p>
                <button type="button" className="secondary" disabled={busy || period.period_start !== asDate(new Date())} onClick={() => void capture('start')}>Capture start snapshot today</button>
                <button type="button" className="secondary" disabled={busy || period.period_end !== asDate(new Date())} onClick={() => void capture('end')}>Capture end snapshot today</button>
              </div>
              <div className="books-opening-actions">
                <button type="button" className="secondary" disabled={busy} onClick={() => { setOpenDate(period.period_start); setOpenForm((x) => !x); }}>Opening balance</button>
                <button type="button" className="secondary" disabled={busy} onClick={() => { setOpenSource('safe'); setOpenDate(period.period_end); setOpenForm((x) => !x); }}>End-of-month safe count</button>
                {openForm && (
                  <div className="books-opening-form">
                    <label>Source<select value={openSource} onChange={(e) => setOpenSource(e.target.value)}>{SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select></label>
                    <label>As of<input type="date" value={openDate} onChange={(e) => setOpenDate(e.target.value)} /></label>
                    <label>Balance ($)<input type="number" step="0.01" value={openAmount} onChange={(e) => setOpenAmount(e.target.value)} /></label>
                    <label>Note<input value={openNote} onChange={(e) => setOpenNote(e.target.value)} /></label>
                    <button type="button" disabled={busy} onClick={() => void saveOpening()}>Save balance</button>
                  </div>
                )}
              </div>
              <div className="books-lock-footer">
                <span>{pending ? `Fix ${pending} check(s) first` : 'Ready to close'}</span>
                <button type="button" disabled={busy || period.period_type !== 'month' || pending > 0} onClick={() => void finalize()}>Close {monthLabel(period.period_start)}</button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
