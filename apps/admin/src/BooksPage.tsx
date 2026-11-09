import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import { BooksViews, type Sheet } from './books/BooksViews';
import { normalizeReport } from './books/booksMath';
import { addCdtfaExcelSheet, addCdtfaPdfPages } from './books/cdtfaExport';
import { loadCdtfaPrintModel, type CdtfaPrintModel } from './books/cdtfaLoad';
import { monthsInRange, parseFiling, spanBounds, spanTitle, type BooksSpan } from './books/booksSpan';
import { addArchiveSheet, appendPdf, archivePlan, periodHasActivity, zipStore } from './books/booksArchive';
import { fillCdtfaPdfBytes, loadCdtfaTemplate, paperToCdtfaDoc } from './books/cdtfaPdf';
import { combineMonthWorkbooks, type BooksSlice } from './books/combineBooks';
import type { CdtfaFrequency } from './books/cdtfaResolve';
import { monthLabel } from './books/booksMath';
import { buildBooksExcel, buildBooksPdf, downloadBytes } from './books/export';
import { loadBooksPayoutContext, loadCommissionOverrides } from './books/loadPayoutContext';
import { computePayoutPersonBalances, loadPayoutLedgerData, BOOKS_WORKBOOK_VERSION, type PersonBalance } from './books/payoutLedger';
import { canonicalPersonKey, mergeEmployeeIds } from './books/personMerge';
import { buildBooksWorkbook, loadBooksMoney } from './books/workbook';
import type { BooksPayoutContext, InventorySummary, Period, ReceivedItem, Report } from './books/types';
import type { CommissionOverride } from './payouts';
import { loadErrorMessage } from './booksLoadErrors';

type Props = {
  client: SupabaseClient;
  storeId?: string;
  money: (cents: number) => string;
  native?: boolean;
  onNativeNavigation?: (inReport: boolean, title?: string, back?: () => void) => void;
};

const asDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
async function loadOneMonth(client: SupabaseClient, p: Period) {
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
    const ownerRes = await client.rpc('portal_books_inventory_owner', { p_period: p.id });
    if (!ownerRes.error && ownerRes.data) inv = { ...inv, owner: ownerRes.data as InventorySummary['owner'] };
    recv = (recRes.data || []) as ReceivedItem[];
  }
  return { report: { ...normalizeReport(rawReport), inventory_summary: inv, items_received: recv }, inventory: inv, received: recv };
}

const emptyInventory = (): InventorySummary => ({
  start_unit_count: 0, end_unit_count: 0, start_source: 'approximate', end_source: 'approximate',
  sold_units: 0, received_units: 0, return_to_stock_units: 0, giveaway_units: 0, replacement_units: 0, return_count: 0, defective_units: 0,
  giveaways: [], replacements: [], returns: [], defective_moves: [],
});

export function BooksPage({ client, storeId: storeIdProp, money, native = false, onNativeNavigation }: Props) {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [inventory, setInventory] = useState<InventorySummary>(emptyInventory());
  const [received, setReceived] = useState<ReceivedItem[]>([]);
  const [payoutCtx, setPayoutCtx] = useState<BooksPayoutContext | null>(null);
  const [overrides, setOverrides] = useState<Map<string, CommissionOverride>>(new Map());
  const [moneyData, setMoneyData] = useState<Awaited<ReturnType<typeof loadBooksMoney>> | null>(null);
  const [ledgerBalances, setLedgerBalances] = useState<PersonBalance[] | null>(null);
  const [staffPersonIds, setStaffPersonIds] = useState<{ paulIds: string[]; jacobIds: string[] }>({ paulIds: [], jacobIds: [] });
  const [costFlagSaleIds, setCostFlagSaleIds] = useState<Set<string>>(new Set());
  const [duplicateDecisions, setDuplicateDecisions] = useState<Record<string, 'keep' | 'remove'>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [exportsPreparing, setExportsPreparing] = useState(false);
  const [exportFiles, setExportFiles] = useState<{ excel: Uint8Array; pdf: Uint8Array } | null>(null);
  const [taxForm, setTaxForm] = useState<CdtfaPrintModel | null>(null);
  const [span, setSpan] = useState<BooksSpan>('month');
  const [filing, setFiling] = useState<CdtfaFrequency | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [parts, setParts] = useState<{ label: string; period: Period; report: Report; inventory: InventorySummary; received: ReceivedItem[]; money: Awaited<ReturnType<typeof loadBooksMoney>>; decisions: Record<string, 'keep' | 'remove'> }[]>([]);
  const [sheet, setSheet] = useState<Sheet>('hub');
  const [desktopTab, setDesktopTab] = useState<Sheet>('sales');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadRetry, setLoadRetry] = useState(0);

  const selected = useMemo(() => periods.find((p) => p.id === periodId) || null, [periods, periodId]);

  const resolveStoreId = useCallback(async () => {
    if (storeIdProp) return storeIdProp;
    const uid = (await client.auth.getUser()).data.user?.id;
    if (!uid) throw new Error('Not signed in');
    const { data, error: staffErr } = await client.from('staff').select('store_id').eq('user_id', uid).maybeSingle();
    if (staffErr) throw staffErr;
    const fromStaff = String(data?.store_id || '');
    if (fromStaff) return fromStaff;
    const admins = await client.from('portal_admins').select('store_id').eq('user_id', uid).maybeSingle();
    if (admins.error) throw admins.error;
    return String(admins.data?.store_id || '');
  }, [client, storeIdProp]);

  const loadPeriods = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_books_list', { p_from: '2026-01-01', p_to: asDate(new Date()) });
    if (e) throw e;
    const loaded = ((data || []) as Period[]).filter((p) => p.period_type === 'month');
    loaded.sort((a, b) => b.period_start.localeCompare(a.period_start));
    setPeriods(loaded);
    setPeriodId((cur) => (cur && loaded.some((p) => p.id === cur) ? cur : loaded[0]?.id || ''));
  }, [client]);

  const loadPayoutSide = useCallback(async (storeId: string, periodStart: string) => {
    const ctx = await loadBooksPayoutContext(client, storeId);
    const ov = await loadCommissionOverrides(client, storeId);
    const [md, ledgerRaw, costFlags] = await Promise.all([
      loadBooksMoney(client, periodStart),
      loadPayoutLedgerData(client, storeId, ov),
      client.from('sale_payout_cost_flags').select('sale_id').eq('store_id', storeId),
    ]);
    setCostFlagSaleIds(new Set((costFlags.data || []).map((f) => String(f.sale_id))));
    const balances = computePayoutPersonBalances({
      staff: ctx.staff,
      peopleSlots: ctx.peopleSlots,
      rules: ctx.rules,
      cfg: ctx.cfg,
      frozen: ctx.frozen,
      ...ledgerRaw,
    });
    setPayoutCtx(ctx);
    setOverrides(ov);
    setMoneyData(md);
    setLedgerBalances(balances);
    const ids = mergeEmployeeIds(ctx.staff, ctx.peopleSlots);
    const paulList: string[] = [];
    const jacobList: string[] = [];
    for (const s of ctx.staff) {
      if (canonicalPersonKey(s.display_name, s.email) === 'paul') paulList.push(s.user_id);
      if (canonicalPersonKey(s.display_name, s.email) === 'jacob') jacobList.push(s.user_id);
    }
    if (ids.paulId && !paulList.includes(ids.paulId)) paulList.push(ids.paulId);
    if (ids.jacobId && !jacobList.includes(ids.jacobId)) jacobList.push(ids.jacobId);
    setStaffPersonIds({ paulIds: paulList, jacobIds: jacobList });
  }, [client]);

  const loadSpan = useCallback(async (p: Period, nextSpan: BooksSpan, known: Period[]) => {
    setBusy(true); setError(''); setExportFiles(null);
    try {
      const storeId = await resolveStoreId();
      const bounds = spanBounds(p.period_start, nextSpan);
      const covered = known.filter((row) => row.period_start >= bounds.start && row.period_start <= bounds.end);
      const targets = (covered.length ? covered : [p]).slice().sort((a, b) => a.period_start.localeCompare(b.period_start));
      if (storeId) await loadPayoutSide(storeId, targets[targets.length - 1].period_start);
      const loaded = [];
      for (const month of targets) {
        const piece = await loadOneMonth(client, month);
        const saved = localStorage.getItem(`books-dup-${month.id}`);
        const decisions = saved ? JSON.parse(saved) as Record<string, 'keep' | 'remove'> : {};
        const moneyMonth = await loadBooksMoney(client, month.period_start);
        loaded.push({ label: monthLabel(month.period_start), period: month, ...piece, money: moneyMonth, decisions });
      }
      const anchor = loaded.find((row) => row.period.id === p.id) || loaded[loaded.length - 1];
      setParts(loaded);
      setReport(anchor.report);
      setInventory(anchor.inventory);
      setReceived(anchor.received);
      setDuplicateDecisions(anchor.decisions);
    } catch (e) {
      console.error('Books load failed', e);
      setError(loadErrorMessage(e, nextSpan));
    } finally { setBusy(false); }
  }, [client, loadPayoutSide, resolveStoreId]);

  useEffect(() => { void loadPeriods().catch((e) => setError(loadErrorMessage(e, 'month'))); }, [loadPeriods]);
  useEffect(() => { if (selected) void loadSpan(selected, span, periods); }, [selected, span, periods, loadSpan, loadRetry]);
  useEffect(() => { setSheet('hub'); }, [periodId]);

  const builtSlices = useMemo(() => {
    if (!payoutCtx || !parts.length) return [] as BooksSlice[];
    return parts.map((part) => {
      const decisions = part.period.id === selected?.id ? duplicateDecisions : part.decisions;
      const hidden = new Set(Object.entries(decisions).filter(([, value]) => value === 'remove').map(([key]) => key));
      return {
        label: part.label,
        workbook: buildBooksWorkbook({
          report: part.report,
          inventory: part.inventory,
          received: part.received,
          payoutCtx,
          overrides,
          money: part.money,
          duplicateHidden: hidden,
          duplicateDecisions: decisions,
          ledgerBalances: ledgerBalances || undefined,
          paulIds: staffPersonIds.paulIds,
          jacobIds: staffPersonIds.jacobIds,
          costFlagSaleIds,
        }),
      };
    });
  }, [parts, payoutCtx, overrides, duplicateDecisions, ledgerBalances, staffPersonIds, costFlagSaleIds, selected?.id]);
  const slices = useMemo(() => (builtSlices.length > 1 ? builtSlices : []), [builtSlices]);
  const workbook = useMemo(() => (builtSlices.length > 1 ? combineMonthWorkbooks(builtSlices) : builtSlices[0]?.workbook ?? null), [builtSlices]);

  const totals = useMemo(() => workbook?.sales.totals ?? null, [workbook]);

  const lockedStaleMath = useMemo(() => {
    if (!selected || selected.status !== 'locked' || !report) return false;
    const v = Number(report.books_workbook_version || 0);
    return v < BOOKS_WORKBOOK_VERSION;
  }, [selected, report]);

  const lockedMonths = useMemo(() => periods.filter((p) => p.status === 'locked').map((p) => p.period_start), [periods]);

  const bounds = selected ? spanBounds(selected.period_start, span) : null;
  const viewPeriod = useMemo(() => {
    if (!selected || !bounds) return selected;
    if (span === 'month') return selected;
    const covered = monthsInRange(bounds.start, bounds.end);
    const locked = covered.every((month) => periods.some((row) => row.period_start === month && row.status === 'locked'));
    return { ...selected, period_start: bounds.start, period_end: bounds.end, status: locked ? 'locked' as const : 'draft' as const };
  }, [selected, bounds?.start, bounds?.end, span, periods]);
  const spanOptions = useMemo(() => {
    if (span === 'year') return [...new Set(periods.map((row) => row.period_start.slice(0, 4)))].map((year) => ({ value: `${year}-01-01`, label: year }));
    if (span === 'quarter') {
      const starts = [...new Set(periods.map((row) => spanBounds(row.period_start, 'quarter').start))];
      return starts.map((start) => ({ value: start, label: spanTitle(start, 'quarter') }));
    }
    return periods.map((row) => ({ value: row.period_start, label: monthLabel(row.period_start) }));
  }, [periods, span]);
  const spanValue = bounds?.start || '';
  const onSpanValue = (start: string) => {
    const next = spanBounds(start, span);
    const match = periods.find((row) => row.period_start >= next.start && row.period_start <= next.end);
    if (match) setPeriodId(match.id);
  };

  useEffect(() => {
    void client.rpc('portal_cdtfa_filing').then((res) => {
      if (!res.error) setFiling(parseFiling(res.data));
    });
  }, [client]);
  useEffect(() => { if (span === 'year' && filing !== 'yearly') setSpan('quarter'); }, [span, filing]);

  useEffect(() => {
    if (!workbook || !viewPeriod || !selected) { setExportFiles(null); setTaxForm(null); return; }
    let cancelled = false;
    setExportsPreparing(true);
    void (async () => {
      try {
        let excel: Uint8Array;
        let pdf: Uint8Array;
        const title = spanTitle(viewPeriod.period_start, span);
        const exportOptions = { title, slices, word: span === 'year' ? 'year' : span === 'quarter' ? 'quarter' : 'month' };
        if (span === 'month' && selected.status === 'locked') {
          const [x, pdfRpc] = await Promise.all([
            client.rpc('portal_books_frozen_export', { p_period: selected.id, p_format: 'excel' }),
            client.rpc('portal_books_frozen_export', { p_period: selected.id, p_format: 'pdf' }),
          ]);
          if (x.error) throw x.error;
          if (pdfRpc.error) throw pdfRpc.error;
          const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
          excel = decode(x.data as string);
          pdf = decode(pdfRpc.data as string);
        } else {
          const [builtExcel, builtPdf] = await Promise.all([
            buildBooksExcel(viewPeriod, workbook, title, exportOptions),
            buildBooksPdf(viewPeriod, workbook, money, exportOptions),
          ]);
          excel = builtExcel instanceof Uint8Array ? builtExcel : new Uint8Array(builtExcel);
          pdf = builtPdf instanceof Uint8Array ? builtPdf : new Uint8Array(builtPdf);
        }
        const tax = await loadCdtfaPrintModel(client, viewPeriod.period_start, viewPeriod.period_end);
        if (!cancelled) setTaxForm(tax);
        if (tax) {
          try {
            excel = await addCdtfaExcelSheet(excel, tax);
            pdf = await addCdtfaPdfPages(pdf, tax);
          } catch (err) {
            console.error('sales tax form export', err);
          }
        }
        if (!cancelled) setExportFiles({ excel, pdf });
      } catch (e) {
        if (!cancelled) console.error('export prep', e);
      } finally { if (!cancelled) setExportsPreparing(false); }
    })();
    return () => { cancelled = true; };
  }, [client, workbook, selected, viewPeriod, money, span, slices]);

  useEffect(() => {
    if (!native || !onNativeNavigation) return;
    onNativeNavigation(false, 'Books');
  }, [native, onNativeNavigation]);

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

  async function downloadAll() {
    if (!payoutCtx || archiveBusy) return;
    setArchiveBusy(true);
    setError('');
    try {
      const loaded = new Map<string, BooksSlice>();
      for (const month of periods) {
        const piece = await loadOneMonth(client, month);
        const saved = localStorage.getItem(`books-dup-${month.id}`);
        const decisions = saved ? JSON.parse(saved) as Record<string, 'keep' | 'remove'> : {};
        const moneyMonth = await loadBooksMoney(client, month.period_start);
        const hidden = new Set(Object.entries(decisions).filter(([, value]) => value === 'remove').map(([key]) => key));
        loaded.set(month.id, {
          label: monthLabel(month.period_start),
          workbook: buildBooksWorkbook({
            report: piece.report,
            inventory: piece.inventory,
            received: piece.received,
            payoutCtx,
            overrides,
            money: moneyMonth,
            duplicateHidden: hidden,
            duplicateDecisions: decisions,
            ledgerBalances: ledgerBalances || undefined,
            paulIds: staffPersonIds.paulIds,
            jacobIds: staffPersonIds.jacobIds,
            costFlagSaleIds,
          }),
        });
      }
      const template = await loadCdtfaTemplate();
      const files: { name: string; bytes: Uint8Array }[] = [];
      const book = new ExcelJS.Workbook();
      const included = new Set<string>();
      for (const item of archivePlan(periods)) {
        const slices = item.months.map((month) => loaded.get(month.id)).filter((slice): slice is BooksSlice => !!slice);
        if (!slices.length) continue;
        if (item.kind === 'month') {
          const tax = await loadCdtfaPrintModel(client, item.start, item.end);
          if (!tax || !periodHasActivity(slices[0].workbook, tax.lines)) continue;
          included.add(item.months[0].id);
          await pack(item, slices, tax);
        } else if (item.months.some((month) => included.has(month.id))) {
          const tax = await loadCdtfaPrintModel(client, item.start, item.end);
          if (tax) await pack(item, slices, tax);
        }
      }
      if (!files.length) throw new Error('No periods with activity to export.');
      const excelOut = await book.xlsx.writeBuffer();
      files.push({ name: 'Books-all-periods.xlsx', bytes: new Uint8Array(excelOut) });
      downloadBytes('Books-all.zip', zipStore(files), 'application/zip');

      async function pack(item: ReturnType<typeof archivePlan>[number], slices: BooksSlice[], tax: CdtfaPrintModel) {
        const workbook = slices.length > 1 ? combineMonthWorkbooks(slices) : slices[0].workbook;
        const period = { ...item.months[item.months.length - 1], period_start: item.start, period_end: item.end };
        const built = await buildBooksPdf(period, workbook, money, {
          title: item.title,
          slices: slices.length > 1 ? slices : [],
          word: item.kind === 'quarter' ? 'quarter' : 'month',
        });
        const reportPdf = built instanceof Uint8Array ? built : new Uint8Array(built);
        const formPdf = await fillCdtfaPdfBytes(template, paperToCdtfaDoc(tax));
        const pdf = await appendPdf(reportPdf, formPdf);
        files.push({ name: `${item.title.replace(/\s+/g, '-')}.pdf`, bytes: pdf });
        addArchiveSheet(book, item.title, workbook, tax);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not export every period.');
    } finally {
      setArchiveBusy(false);
    }
  }

  const fileStem = viewPeriod ? spanTitle(viewPeriod.period_start, span).replace(/\s+/g, '-') : 'Books';
  const downloadExcel = () => exportFiles && downloadBytes(`Books-${fileStem}.xlsx`, exportFiles.excel, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const downloadPdf = () => exportFiles && downloadBytes(`Books-${fileStem}.pdf`, exportFiles.pdf, 'application/pdf');

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
      {error && (
        <div className="books-load-error" role="alert">
          <p>{error}</p>
          <button type="button" className="secondary" disabled={busy} onClick={() => { setError(''); setLoadRetry((n) => n + 1); }}>Try again</button>
        </div>
      )}
      {viewPeriod && selected && (report && workbook ? (
        <BooksViews
          native={native}
          money={money}
          period={viewPeriod}
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
          onReload={async () => { await loadPeriods(); if (selected) await loadSpan(selected, span, periods); }}
          desktopTab={desktopTab}
          setDesktopTab={setDesktopTab}
          onDuplicateDecision={saveDuplicateDecision}
          absorbFees={!!payoutCtx?.cfg.absorbFees}
          onlineChannels={payoutCtx?.cfg.channels || []}
          lockedStaleMath={lockedStaleMath}
          lockedMonths={lockedMonths}
          taxForm={taxForm}
          span={span}
          setSpan={setSpan}
          filing={filing}
          onFiling={setFiling}
          spanOptions={spanOptions}
          spanValue={spanValue}
          onSpanValue={onSpanValue}
          slices={slices}
          spanWord={span === 'year' ? 'year' : span === 'quarter' ? 'quarter' : 'month'}
          showLock={span === 'month'}
          onDownloadAll={() => void downloadAll()}
          archiveBusy={archiveBusy}
        />
      ) : (
        <div className={`native-report-body books-phone${native ? '' : ' books-desktop-shell'}`}>
          <div className="books-phone-period">
            <label>
              <span className="sr">Report period</span>
              <select aria-label="Report period" value={spanValue} disabled={!periods.length} onChange={(e) => onSpanValue(e.target.value)}>
                {spanOptions.map((row) => (
                  <option key={row.value} value={row.value}>{row.label}</option>
                ))}
              </select>
            </label>
          </div>
          {busy && <p className="native-report-footnote">Loading books…</p>}
        </div>
      ))}
    </div>
  );
}
