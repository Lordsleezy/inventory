import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BooksClosePanel } from './books/BooksClosePanel';
import { computeBookTotals, formatSanityLine, monthLabel, normalizeReport, OCTOBER_2026_TARGETS } from './books/booksMath';
import { buildBooksExcel, buildBooksPdf, downloadBytes } from './books/export';
import { buildBooksWorkbook } from './books/workbook';
import type { InventorySummary, Period, ReceivedItem, Report } from './books/types';

type Props = { client: SupabaseClient; money: (cents: number) => string; native?: boolean; onNativeNavigation?: (inReport: boolean, title?: string, back?: () => void) => void };

const asDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const emptyInventory = (): InventorySummary => ({
  start_unit_count: 0, end_unit_count: 0, start_source: 'approximate', end_source: 'approximate',
  sold_units: 0, received_units: 0, giveaway_units: 0, replacement_units: 0, return_count: 0, defective_units: 0,
  giveaways: [], replacements: [], returns: [], defective_moves: [],
});

export function BooksPage({ client, money, native = false }: Props) {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [inventory, setInventory] = useState<InventorySummary>(emptyInventory);
  const [received, setReceived] = useState<ReceivedItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [exportsPreparing, setExportsPreparing] = useState(false);
  const [exportFiles, setExportFiles] = useState<{ excel: Uint8Array; pdf: Uint8Array } | null>(null);

  const selected = useMemo(() => periods.find((p) => p.id === periodId) || null, [periods, periodId]);

  const loadPeriods = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_books_list', { p_from: '2026-01-01', p_to: asDate(new Date()) });
    if (e) throw e;
    const loaded = ((data || []) as Period[]).filter((p) => p.period_type === 'month');
    const withData: Period[] = [];
    for (const p of loaded) {
      const { data: rpt } = await client.rpc('portal_books_report', { p_period: p.id });
      const r = rpt as Report;
      const hasData = [r?.sales, r?.fees, r?.labels, r?.expenses, r?.returns, r?.dispositions, r?.inventory_bought].some((rows) => rows?.length);
      if (p.status === 'locked' || hasData) withData.push(p);
    }
    withData.sort((a, b) => b.period_start.localeCompare(a.period_start));
    setPeriods(withData);
    setPeriodId((cur) => cur || withData[0]?.id || '');
  }, [client]);

  const loadMonth = useCallback(async (p: Period) => {
    setBusy(true); setError(''); setExportFiles(null);
    try {
      const { data: raw, error: re } = await client.rpc('portal_books_report', { p_period: p.id });
      if (re) throw re;
      let inv = emptyInventory();
      let recv: ReceivedItem[] = [];
      const rawReport = raw as Report;
      if (p.status === 'locked') {
        inv = (rawReport.inventory_summary as InventorySummary) || inv;
        recv = (rawReport.items_received as ReceivedItem[]) || [];
      } else {
        const [invRes, recRes, statusRes] = await Promise.all([
          client.rpc('portal_books_inventory_summary', { p_period: p.id }),
          client.rpc('portal_books_items_received', { p_period: p.id }),
          client.rpc('portal_books_refresh_readiness', { p_period: p.id }),
        ]);
        if (invRes.error) throw invRes.error;
        if (recRes.error) throw recRes.error;
        if (statusRes.error) throw statusRes.error;
        inv = (invRes.data || emptyInventory()) as InventorySummary;
        recv = (recRes.data || []) as ReceivedItem[];
        rawReport.period = { ...rawReport.period, status: statusRes.data as Period['status'] };
      }
      const next = normalizeReport({ ...rawReport, inventory_summary: inv, items_received: recv });
      setReport(next);
      setInventory(inv);
      setReceived(recv);
      if (p.period_start === OCTOBER_2026_TARGETS.period_start) {
        console.info('[Books October sanity]', formatSanityLine(computeBookTotals(next)), 'targets', OCTOBER_2026_TARGETS);
      }
    } catch (e) {
      console.error('Books load failed', e);
      setError("Couldn't load this month. Try again.");
    } finally { setBusy(false); }
  }, [client]);

  useEffect(() => { void loadPeriods().catch(() => setError("Couldn't load periods")); }, [loadPeriods]);
  useEffect(() => { if (selected) void loadMonth(selected); }, [selected, loadMonth]);

  const workbook = useMemo(() => (report ? buildBooksWorkbook(report, inventory, received) : null), [report, inventory, received]);
  const totals = useMemo(() => (report ? computeBookTotals(report) : null), [report]);

  useEffect(() => {
    if (!workbook || !selected) { setExportFiles(null); return; }
    let cancelled = false;
    setExportsPreparing(true);
    void (async () => {
      try {
        if (selected.status === 'locked') {
          const [x, pdfRpc] = await Promise.all([
            client.rpc('portal_books_frozen_export', { p_period: selected.id, p_format: 'excel' }),
            client.rpc('portal_books_frozen_export', { p_period: selected.id, p_format: 'pdf' }),
          ]);
          if (x.error) throw x.error;
          if (pdfRpc.error) throw pdfRpc.error;
          const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
          if (!cancelled) setExportFiles({ excel: decode(x.data as string), pdf: decode(pdfRpc.data as string) });
        } else {
          const [excel, pdf] = await Promise.all([
            buildBooksExcel(selected, workbook, monthLabel(selected.period_start)),
            buildBooksPdf(selected, workbook, money),
          ]);
          if (!cancelled) setExportFiles({
            excel: excel instanceof Uint8Array ? excel : new Uint8Array(excel),
            pdf: pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf),
          });
        }
      } catch (e) {
        if (!cancelled) console.error('export prep', e);
      } finally { if (!cancelled) setExportsPreparing(false); }
    })();
    return () => { cancelled = true; };
  }, [client, workbook, selected, money]);

  function printReports() {
    document.body.classList.add('books-printing');
    window.print();
    window.setTimeout(() => document.body.classList.remove('books-printing'), 500);
  }

  return (
    <div className={`books-page books-workbook${native ? ' books-native' : ''}`}>
      {!native && (
        <header>
          <div>
            <div className="eyebrow">ACCOUNTING</div>
            <h1>Books</h1>
            <p>Monthly printable workbooks for sales, expenses, and inventory.</p>
          </div>
        </header>
      )}
      {error && <div className="alert" role="alert">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></div>}

      <div className="books-toolbar books-month-toolbar">
        <label className="books-month-picker">
          Month
          <select value={periodId} disabled={busy || !periods.length} onChange={(e) => setPeriodId(e.target.value)}>
            {periods.map((p) => <option key={p.id} value={p.id}>{monthLabel(p.period_start)}{p.status === 'locked' ? ' · locked' : ''}</option>)}
          </select>
        </label>
        <div className="books-export-actions">
          <button type="button" className="books-download" disabled={!exportFiles || exportsPreparing} onClick={() => exportFiles && downloadBytes(`Books-${selected?.period_start}.xlsx`, exportFiles.excel, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}>
            ↓ {exportsPreparing ? 'Preparing…' : 'Excel'}
          </button>
          <button type="button" className="books-download" disabled={!exportFiles || exportsPreparing} onClick={() => exportFiles && downloadBytes(`Books-${selected?.period_start}.pdf`, exportFiles.pdf, 'application/pdf')}>
            ↓ PDF
          </button>
          <button type="button" className="books-download secondary" disabled={!workbook} onClick={printReports}>Print</button>
        </div>
      </div>

      {busy && !report && <p>Loading books…</p>}
      {totals && selected && workbook && (
        <>
          <p className="books-inline-summary">
            Sales <b>{money(totals.revenue)}</b>
            {' · '}COGS <b>{money(totals.cost)}</b>
            {' · '}Fees + labels <b>{money(totals.feesAndLabels)}</b>
            {' · '}Commission <b>{money(totals.commission)}</b>
            {' · '}Profit <b className="positive">{money(totals.profit)}</b>
            <small> {selected.period_start} – {selected.period_end}</small>
          </p>

          <SpreadsheetTable title="Expenses" headers={['Date', 'Category', 'Description', 'Amount', 'SKU / order', 'Paid by', 'Reimb?', 'Source']} rows={workbook.expenses.rows.map((r) => [r.date, r.category, r.description, money(r.amount_cents), r.sku_or_order, r.paid_by, r.needs_reimbursement, r.source])} footer={workbook.expenses.categoryTotals.map((c) => [`${c.category} subtotal`, '', '', money(c.amount_cents)]).concat([['Grand total', '', '', money(workbook.expenses.total_cents)]])} />

          <SpreadsheetTable title="Sales" headers={['Date', 'SKU', 'Title', 'Channel', 'Order #', 'Qty', 'Price', 'Tax', 'Mkt fees', 'Card fees', 'Buyer ship', 'Label', 'COGS', 'Profit', 'Commission', 'Notes']} rows={workbook.sales.rows.map((r) => [r.date, r.sku, r.title, r.channel, r.order_no, r.qty, money(r.price_cents), money(r.tax_cents), money(r.marketplace_fees_cents), money(r.card_fees_cents), money(r.buyer_shipping_cents), money(r.label_cost_cents), r.cost_cents == null ? '—' : money(r.cost_cents), r.profit_cents == null ? '—' : money(r.profit_cents), r.commission_cents == null ? '—' : money(r.commission_cents), r.profit_notes])} footer={workbook.sales.channelTotals.map((c) => [`${c.channel} subtotal`, '', '', '', '', c.count, money(c.revenue_cents), '', '', '', '', '', '', money(c.profit_cents)]).concat([['Period totals', '', '', '', '', '', money(totals.revenue), '', '', '', '', money(totals.labelCostsOnSales), money(totals.cost), money(totals.profit), money(totals.commission)]])} />

          <section className="books-spreadsheet">
            <h2 className="books-kicker">Inventory</h2>
            <div className="books-table-wrap">
              <table className="books-table">
                <tbody>
                  <tr><th>Start units</th><td>{inventory.start_unit_count}</td><td>{inventory.start_source}</td></tr>
                  <tr><th>End units</th><td>{inventory.end_unit_count}</td><td>{inventory.end_source}</td></tr>
                  <tr><th>Sold</th><td>{inventory.sold_units}</td><td /></tr>
                  <tr><th>Received</th><td>{inventory.received_units}</td><td /></tr>
                  <tr><th>Giveaways</th><td>{inventory.giveaway_units}</td><td /></tr>
                  <tr><th>Replacements</th><td>{inventory.replacement_units}</td><td /></tr>
                  <tr><th>Returns</th><td>{inventory.return_count}</td><td /></tr>
                  <tr><th>Defective</th><td>{inventory.defective_units}</td><td /></tr>
                </tbody>
              </table>
            </div>
            <SpreadsheetTable title="Giveaways" headers={['SKU', 'Title', 'Cost', 'Given to', 'Date']} rows={(inventory.giveaways || []).map((g) => [String(g.sku ?? ''), String(g.title ?? ''), money(Number(g.cost_cents)), String(g.given_to ?? ''), String(g.date || '').slice(0, 10)])} compact />
            <SpreadsheetTable title="Replacements" headers={['SKU', 'Title', 'Original sale', 'Bad unit', 'Extra cost', 'Date']} rows={(inventory.replacements || []).map((r) => [String(r.sku ?? ''), String(r.title ?? ''), String(r.original_sale_id ?? ''), String(r.bad_unit_status ?? ''), money(Number(r.extra_cost_cents || 0)), String(r.date || '').slice(0, 10)])} compact />
            <SpreadsheetTable title="Returns" headers={['SKU', 'Order', 'Channel', 'Refund', 'Label', 'Status', 'Disposition']} rows={(inventory.returns || []).map((r) => [String(r.sku ?? ''), String(r.order_id ?? ''), String(r.channel ?? ''), money(Number(r.refund_cents || 0)), money(Number(r.label_cents || 0)), String(r.status ?? ''), String(r.disposition ?? r.route_to ?? '')])} compact />
          </section>

          <SpreadsheetTable title="Items received" headers={['Received', 'SKU', 'Title', 'Brand', 'Category', 'Condition', 'Qty', 'Cost', 'Floor price', 'Location', 'Receiver', 'Listing / status']} rows={workbook.received.map((r) => [String(r.received_at || '').slice(0, 10), String(r.sku ?? ''), String(r.title ?? ''), String(r.brand ?? ''), String(r.category ?? ''), String(r.condition ?? ''), Number(r.qty_on_hand ?? 0), money(Number(r.cost_cents)), money(Number(r.ask_cents)), String(r.location ?? ''), String(r.receiver_name ?? ''), String(r.listing_status ?? '')])} />

          {report && selected && (
            <BooksClosePanel
              client={client}
              money={money}
              period={selected}
              report={report}
              inventory={inventory}
              received={received}
              busy={busy}
              setBusy={setBusy}
              onError={setError}
              onReload={async () => { await loadPeriods(); if (selected) await loadMonth(selected); }}
            />
          )}
        </>
      )}
    </div>
  );
}

function SpreadsheetTable({ title, headers, rows, footer, compact }: { title: string; headers: string[]; rows: (string | number)[][]; footer?: (string | number)[][]; compact?: boolean }) {
  return (
    <section className={`books-spreadsheet${compact ? ' books-spreadsheet-compact' : ''}`}>
      <h2 className="books-kicker">{title}</h2>
      <div className="books-table-wrap">
        <table className="books-table">
          <thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.length ? rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>) : <tr><td colSpan={headers.length} className="books-empty">Nothing this month</td></tr>}
            {(footer || []).map((row, i) => <tr key={`f${i}`} className="books-total-row">{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
    </section>
  );
}
