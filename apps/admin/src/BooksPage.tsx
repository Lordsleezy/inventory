import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BooksViews, type Sheet } from './books/BooksViews';
import { formatSanityLine, normalizeReport, OCTOBER_2026_TARGETS } from './books/booksMath';
import { buildBooksExcel, buildBooksPdf, downloadBytes } from './books/export';
import { buildBooksWorkbook } from './books/workbook';
import type { InventorySummary, Period, ReceivedItem, Report } from './books/types';

type Props = {
  client: SupabaseClient;
  money: (cents: number) => string;
  native?: boolean;
  onNativeNavigation?: (inReport: boolean, title?: string, back?: () => void) => void;
};

const asDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const emptyInventory = (): InventorySummary => ({
  start_unit_count: 0, end_unit_count: 0, start_source: 'approximate', end_source: 'approximate',
  sold_units: 0, received_units: 0, return_to_stock_units: 0, giveaway_units: 0, replacement_units: 0, return_count: 0, defective_units: 0,
  giveaways: [], replacements: [], returns: [], defective_moves: [],
});

const SHEET_TITLES: Record<Sheet, string> = {
  hub: 'Books', sales: 'Sales', expenses: 'Expenses', payouts: 'Payouts', inventory: 'Inventory', received: 'Items received',
};

export function BooksPage({ client, money, native = false, onNativeNavigation }: Props) {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [inventory, setInventory] = useState<InventorySummary>(emptyInventory);
  const [received, setReceived] = useState<ReceivedItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [exportsPreparing, setExportsPreparing] = useState(false);
  const [exportFiles, setExportFiles] = useState<{ excel: Uint8Array; pdf: Uint8Array } | null>(null);
  const [sheet, setSheet] = useState<Sheet>('hub');
  const [desktopTab, setDesktopTab] = useState<Sheet>('sales');
  const [pickerOpen, setPickerOpen] = useState(false);

  const selected = useMemo(() => periods.find((p) => p.id === periodId) || null, [periods, periodId]);

  const loadPeriods = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_books_list', { p_from: '2026-01-01', p_to: asDate(new Date()) });
    if (e) throw e;
    const loaded = ((data || []) as Period[]).filter((p) => p.period_type === 'month');
    loaded.sort((a, b) => b.period_start.localeCompare(a.period_start));
    setPeriods(loaded);
    setPeriodId((cur) => (cur && loaded.some((p) => p.id === cur) ? cur : loaded[0]?.id || ''));
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
        inv = { ...emptyInventory(), ...(rawReport.inventory_summary as InventorySummary) };
        recv = (rawReport.items_received as ReceivedItem[]) || [];
      } else {
        const [invRes, recRes] = await Promise.all([
          client.rpc('portal_books_inventory_summary', { p_period: p.id }),
          client.rpc('portal_books_items_received', { p_period: p.id }),
        ]);
        if (invRes.error) throw invRes.error;
        if (recRes.error) throw recRes.error;
        inv = { ...emptyInventory(), ...(invRes.data as InventorySummary) };
        recv = (recRes.data || []) as ReceivedItem[];
      }
      const next = normalizeReport({ ...rawReport, inventory_summary: inv, items_received: recv });
      setReport(next);
      setInventory(inv);
      setReceived(recv);
      if (p.period_start === OCTOBER_2026_TARGETS.period_start) {
        const wb = buildBooksWorkbook(next, inv, recv);
        console.info('[Books October sanity]', formatSanityLine(wb.sales.totals), 'targets', OCTOBER_2026_TARGETS);
      }
    } catch (e) {
      console.error('Books load failed', e);
      setError("Couldn't load this month. Try again.");
    } finally { setBusy(false); }
  }, [client]);

  useEffect(() => { void loadPeriods().catch(() => setError("Couldn't load periods")); }, [loadPeriods]);
  useEffect(() => { if (selected) void loadMonth(selected); }, [selected, loadMonth]);
  useEffect(() => { setSheet('hub'); }, [periodId]);

  const workbook = useMemo(() => (report ? buildBooksWorkbook(report, inventory, received) : null), [report, inventory, received]);
  const totals = useMemo(() => workbook?.sales.totals ?? null, [workbook]);

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
            buildBooksExcel(selected, workbook, selected.period_start),
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

  useEffect(() => {
    if (!native || !onNativeNavigation) return;
    if (sheet === 'hub') onNativeNavigation(false, 'Books');
    else onNativeNavigation(true, SHEET_TITLES[sheet], () => setSheet('hub'));
  }, [native, onNativeNavigation, sheet]);

  function printReports() {
    document.body.classList.add('books-printing');
    window.print();
    window.setTimeout(() => document.body.classList.remove('books-printing'), 500);
  }

  const downloadExcel = () => exportFiles && selected && downloadBytes(`Books-${selected.period_start}.xlsx`, exportFiles.excel, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const downloadPdf = () => exportFiles && selected && downloadBytes(`Books-${selected.period_start}.pdf`, exportFiles.pdf, 'application/pdf');

  if (busy && !report) {
    return <p className={native ? 'native-report-empty' : ''}>Loading books…</p>;
  }

  return (
    <div className={`books-page books-mockup${native ? ' books-native' : ''}`}>
      {!native && (
        <header className="books-print-only">
          <h1>Books</h1>
        </header>
      )}
      {error && <div className="alert" role="alert">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></div>}
      {totals && selected && workbook && report && (
        <BooksViews
          native={native}
          money={money}
          period={selected}
          periods={periods}
          periodId={periodId}
          setPeriodId={setPeriodId}
          totals={totals}
          workbook={workbook}
          inventory={inventory}
          report={report}
          received={received}
          sheet={sheet}
          setSheet={setSheet}
          pickerOpen={pickerOpen}
          setPickerOpen={setPickerOpen}
          exportsPreparing={exportsPreparing}
          exportFiles={exportFiles}
          onExcel={downloadExcel}
          onPdf={downloadPdf}
          onPrint={printReports}
          client={client}
          busy={busy}
          setBusy={setBusy}
          onError={setError}
          onReload={async () => { await loadPeriods(); if (selected) await loadMonth(selected); }}
          desktopTab={desktopTab}
          setDesktopTab={setDesktopTab}
        />
      )}
    </div>
  );
}
