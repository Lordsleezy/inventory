import type { SupabaseClient } from '@supabase/supabase-js';
import { buildBooksExcel, buildBooksPdf, bytesBase64 } from './export';
import { BOOKS_WORKBOOK_VERSION } from './payoutLedger';
import { monthLabel } from './booksMath';
import type { BooksWorkbook, InventorySummary, Period, ReceivedItem, Report } from './types';

type Props = {
  client: SupabaseClient;
  money: (c: number) => string;
  period: Period;
  report: Report;
  inventory: InventorySummary;
  received: ReceivedItem[];
  workbook: BooksWorkbook | null;
  uiStatus: 'locked' | 'in_progress' | 'draft';
  busy: boolean;
  setBusy: (b: boolean) => void;
  onError: (msg: string) => void;
  onReload: () => Promise<void>;
  native?: boolean;
  lockedStaleMath?: boolean;
};

export function BooksLock({ client, money, period, report, inventory, received, workbook, uiStatus, busy, setBusy, onError, onReload, native, lockedStaleMath }: Props) {
  const label = monthLabel(period.period_start);

  async function lock() {
    if (!window.confirm(`Lock ${label}? Numbers for this month will be frozen.`)) return;
    setBusy(true);
    try {
      if (!workbook) throw new Error('workbook_missing');
      const payload = { ...report, inventory_summary: inventory, items_received: received, books_workbook_version: BOOKS_WORKBOOK_VERSION };
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
    } catch (err: unknown) {
      console.error(err);
      const msg = String((err as { message?: string })?.message || '');
      if (msg.includes('close_checklist')) onError('This month could not be locked yet. Ask Paul to clear the old checklist requirement.');
      else onError("Couldn't lock this month.");
    } finally { setBusy(false); }
  }

  async function unlock() {
    const reason = window.prompt('Reason to unlock (8+ characters):');
    if (!reason || reason.trim().length < 8) return;
    setBusy(true);
    try {
      const { error: e } = await client.rpc('portal_books_unlock', { p_period: period.id, p_reason: reason.trim() });
      if (e) throw e;
      await onReload();
    } catch { onError("Couldn't unlock this month."); } finally { setBusy(false); }
  }

  async function refreeze() {
    if (!workbook || !window.confirm(`Re-freeze ${label} with current payout math? This replaces the locked Excel/PDF.`)) return;
    setBusy(true);
    try {
      const payload = { ...report, inventory_summary: inventory, items_received: received, books_workbook_version: BOOKS_WORKBOOK_VERSION };
      const [excel, pdf] = await Promise.all([
        buildBooksExcel(period, workbook, `${period.period_start} Books`),
        buildBooksPdf(period, workbook, money),
      ]);
      const { error: e } = await client.rpc('portal_books_refreeze', {
        p_period: period.id,
        p_report: payload,
        p_excel_base64: bytesBase64(excel),
        p_pdf_base64: bytesBase64(pdf),
      });
      if (e) throw e;
      await onReload();
    } catch {
      onError("Couldn't re-freeze this month.");
    } finally { setBusy(false); }
  }

  if (uiStatus === 'locked') {
    return (
      <div className={`books-lock-foot${native ? ' native' : ''}`}>
        <p>
          Locked{period.locked_at ? ` · ${new Date(period.locked_at).toLocaleDateString()}` : ''}
          {' · '}
          <button type="button" className="books-lock-link" disabled={busy} onClick={() => void unlock()}>Unlock</button>
        </p>
        {lockedStaleMath && (
          <p className="books-stale-lock">
            Locked with old math —{' '}
            <button type="button" className="books-lock-link" disabled={busy || !workbook} onClick={() => void refreeze()}>recalculate?</button>
          </p>
        )}
      </div>
    );
  }

  return (
    <p className={`books-lock-foot${native ? ' native' : ''}`}>
      {uiStatus === 'in_progress' ? 'In progress' : 'Draft'}
      {' · '}
      <button type="button" className="books-lock-link" disabled={busy} onClick={() => void lock()}>Lock {label}</button>
    </p>
  );
}
