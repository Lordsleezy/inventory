import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BooksViews, type Sheet } from './books/BooksViews';
import { normalizeReport, OCTOBER_2026_TARGETS } from './books/booksMath';
import { buildBooksExcel, buildBooksPdf, downloadBytes } from './books/export';
import { loadBooksPayoutContext, loadCommissionOverrides } from './books/loadPayoutContext';
import { PAYOUT_COST_RULES_DOC } from './books/payoutTotals';
import { buildBooksWorkbook, loadBooksMoney } from './books/workbook';
import type { BooksPayoutContext, InventorySummary, Period, ReceivedItem, Report } from './books/types';
import type { CommissionOverride } from './payouts';

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
  const [inventory, setInventory] = useState<InventorySummary>(emptyInventory());
  const [received, setReceived] = useState<ReceivedItem[]>([]);
  const [payoutCtx, setPayoutCtx] = useState<BooksPayoutContext | null>(null);
  const [overrides, setOverrides] = useState<Map<string, CommissionOverride>>(new Map());
  const [moneyData, setMoneyData] = useState<Awaited<ReturnType<typeof loadBooksMoney>> | null>(null);
  const [duplicateDecisions, setDuplicateDecisions] = useState<Record<string, 'keep' | 'remove'>>({});
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

  const loadPayoutSide = useCallback(async (storeId: string) => {
    const [ctx, ov, md] = await Promise.all([
      loadBooksPayoutContext(client, storeId),
      loadCommissionOverrides(client, storeId),
      loadBooksMoney(client),
    ]);
    setPayoutCtx(ctx);
    setOverrides(ov);
    setMoneyData(md);
  }, [client]);

  const loadMonth = useCallback(async (p: Period) => {
    setBusy(true); setError(''); setExportFiles(null);
    try {
      const staffRes = await client.from('staff').select('store_id').limit(1).maybeSingle();
      const storeId = String(staffRes.data?.store_id || '');
      if (storeId) await loadPayoutSide(storeId);

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
      const next = { ...normalizeReport(rawReport), inventory_summary: inv, items_received: recv };
      setReport(next);
      setInventory(inv);
      setReceived(recv);

      const saved = localStorage.getItem(`books-dup-${p.id}`);
      if (saved) setDuplicateDecisions(JSON.parse(saved) as Record<string, 'keep' | 'remove'>);

      if (p.period_start === OCTOBER_2026_TARGETS.period_start || p.period_start === '2026-11-01') {
        console.info('[Books payout rules]', PAYOUT_COST_RULES_DOC);
      }
    } catch (e) {
      console.error('Books load failed', e);
      setError("Couldn't load this month. Try again.");
    } finally { setBusy(false); }
  }, [client, loadPayoutSide]);

  useEffect(() => { void loadPeriods().catch(() => setError("Couldn't load periods")); }, [loadPeriods]);
  useEffect(() => { if (selected) void loadMonth(selected); }, [selected, loadMonth]);
  useEffect(() => { setSheet('hub'); }, [periodId]);

  const duplicateHidden = useMemo(
    () => new Set(Object.entries(duplicateDecisions).filter(([, v]) => v === 'remove').map(([k]) => k)),
    [duplicateDecisions],
  );

  const workbook = useMemo(() => {
    if (!report || !payoutCtx || !moneyData) return null;
    return buildBooksWorkbook({
      report,
      inventory,
      received,
      payoutCtx,
      overrides,
      money: moneyData,
      duplicateHidden,
      duplicateDecisions,
    });
  }, [report, inventory, received, payoutCtx, overrides, moneyData, duplicateHidden, duplicateDecisions]);

  const totals = useMemo(() => workbook?.sales.totals ?? null, [workbook]);

  useEffect(() => {
    if (!workbook || !report || !selected) return;
    const proofMonths = new Set([OCTOBER_2026_TARGETS.period_start, '2026-11-01']);
    if (!proofMonths.has(selected.period_start)) return;
    const legacyCommission = (report.payouts || []).reduce((n, r) => n + Number(r.amount_cents || 0), 0);
    const lineCommission = workbook.sales.rows.reduce((n, s) => n + (s.commission_cents ?? 0), 0);
    const { proof } = workbook;
    const pct = proof.profit ? (proof.commission / proof.profit) * 100 : 0;
    console.info('[Books proof]', {
      month: selected.period_start,
      tickets: proof.saleCount,
      revenue_cents: proof.revenue,
      cost_cents: proof.cost,
      fees_labels_cents: proof.feesAndLabels,
      profit_cents: proof.profit,
      commission_cents: proof.commission,
      owner_before_other_cents: proof.ownerBeforeOther,
      other_expenses_cents: totals?.otherExpenses ?? 0,
      owner_keeps_cents: totals?.ownerKeeps ?? 0,
      sum_sales_line_commission_cents: lineCommission,
      legacy_report_payouts_commission_cents: legacyCommission,
      commission_pct_of_profit: Number(pct.toFixed(2)),
      owner_gt_commission: proof.ownerBeforeOther > proof.commission,
      legacy_gap_cents: legacyCommission - proof.commission,
    });
  }, [workbook, report, selected, totals]);

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

  function saveDuplicateDecision(lineId: string, decision: 'keep' | 'remove') {
    if (!selected) return;
    setDuplicateDecisions((prev) => {
      const next = { ...prev, [lineId]: decision };
      localStorage.setItem(`books-dup-${selected.id}`, JSON.stringify(next));
      return next;
    });
  }

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
          onDuplicateDecision={saveDuplicateDecision}
        />
      )}
    </div>
  );
}
