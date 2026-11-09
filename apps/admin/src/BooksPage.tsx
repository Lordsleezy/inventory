import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import { ReportsHome } from './books/ReportsHome';
import { choiceBounds, defaultPeriodId, periodChoices, reportFileStem, yearsFrom } from './books/reportsPeriod';
import { showSpreadsheet } from './books/sheetView';
import { normalizeReport } from './books/booksMath';
import { addCdtfaExcelSheet, addCdtfaPdfPages, cdtfaPdfFileName } from './books/cdtfaExport';
import { loadCdtfaPrintModel, type CdtfaPrintModel } from './books/cdtfaLoad';
import { monthsInRange, parseFiling, spanBounds, spanTitle, type BooksSpan } from './books/booksSpan';
import { addArchiveSheet, appendPdf, archivePlan, periodHasActivity, zipStore } from './books/booksArchive';
import { fillCdtfaPdfBytes, loadCdtfaTemplate, mergePdfBytes, paperToCdtfaDoc } from './books/cdtfaPdf';
import { buildCdtfaWorksheet } from './books/cdtfaWorksheet';
import { officialCdtfaPdf } from './books/cdtfaTrimClient';
import { combineMonthWorkbooks, type BooksSlice } from './books/combineBooks';
import { dueOn, type CdtfaFrequency } from './books/cdtfaResolve';
import { monthLabel } from './books/booksMath';
import { buildBooksExcel, buildBooksPdf, downloadBytes } from './books/export';
import { loadBooksPayoutContext, loadCommissionOverrides } from './books/loadPayoutContext';
import { computePayoutPersonBalances, loadPayoutLedgerData, BOOKS_WORKBOOK_VERSION, type PersonBalance } from './books/payoutLedger';
import { canonicalPersonKey, mergeEmployeeIds } from './books/personMerge';
import { buildBooksWorkbook, loadBooksMoney } from './books/workbook';
import type { BooksPayoutContext, InventorySummary, Period, ReceivedItem, Report, Row } from './books/types';
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
  const [exportFiles, setExportFiles] = useState<{ excel: Uint8Array; pdf: Uint8Array; taxPdf: Uint8Array | null; worksheet: Uint8Array | null } | null>(null);
  const [taxForm, setTaxForm] = useState<CdtfaPrintModel | null>(null);
  const [span, setSpan] = useState<BooksSpan>('month');
  const [filing, setFiling] = useState<CdtfaFrequency | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [parts, setParts] = useState<{ label: string; period: Period; report: Report; inventory: InventorySummary; received: ReceivedItem[]; money: Awaited<ReturnType<typeof loadBooksMoney>>; decisions: Record<string, 'keep' | 'remove'> }[]>([]);
  const [sheet, setSheet] = useState<'hub' | 'sales'>('hub');
  const [desktopTab, setDesktopTab] = useState<'hub' | 'sales'>('sales');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadRetry, setLoadRetry] = useState(0);
  const [reportYear, setReportYear] = useState(() => Number(sessionStorage.getItem('floor-reports-year')) || new Date().getFullYear());
  const [reportPick, setReportPick] = useState(() => sessionStorage.getItem('floor-reports-pick') || defaultPeriodId(new Date()));
  const [fileBusy, setFileBusy] = useState<'' | 'sheet' | 'tax' | 'view-sheet' | 'view-tax' | 'full'>('');
  const [fileError, setFileError] = useState('');

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
          const [builtExcel, pdfRpc] = await Promise.all([
            buildBooksExcel(viewPeriod, workbook, title, exportOptions),
            client.rpc('portal_books_frozen_export', { p_period: selected.id, p_format: 'pdf' }),
          ]);
          if (pdfRpc.error) throw pdfRpc.error;
          const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
          excel = builtExcel instanceof Uint8Array ? builtExcel : new Uint8Array(builtExcel);
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
        let taxPdf: Uint8Array | null = null;
        let taxWorksheet: Uint8Array | null = null;
        if (tax) {
          try {
            excel = await addCdtfaExcelSheet(excel, tax);
            pdf = await addCdtfaPdfPages(pdf, tax);
            const accountRes = await client.rpc('portal_cdtfa_account');
            const account = accountRes.error ? '' : String(accountRes.data || '');
            const ranges = span === 'quarter'
              ? monthsInRange(viewPeriod.period_start, viewPeriod.period_end).map((month) => spanBounds(month, 'month'))
              : [{ start: viewPeriod.period_start, end: viewPeriod.period_end }];
            const parts: Uint8Array[] = [];
            for (const range of ranges) {
              const model = range.start === tax.periodStart ? tax : await loadCdtfaPrintModel(client, range.start, range.end);
              const source = model || tax;
              const filled = await fillCdtfaPdfBytes(await loadCdtfaTemplate(), paperToCdtfaDoc({
                ...source,
                periodStart: range.start,
                periodEnd: range.end,
                open: false,
                recordsNote: null,
                optionTitle: null,
                optionHint: null,
                preparer: '',
                signer: { ...source.signer, account },
              }));
              const district = source.lines.find((line) => line.id === '16')?.dollars ?? 0;
              parts.push((await officialCdtfaPdf(filled, district)).bytes);
            }
            taxPdf = parts.length > 1 ? await mergePdfBytes(parts) : parts[0];
            const district = tax.lines.find((line) => line.id === '16')?.dollars ?? 0;
            const ready = { pageCount: parts.length, warning: null as string | null };
            taxWorksheet = await buildCdtfaWorksheet({
              periodStart: tax.periodStart,
              periodEnd: tax.periodEnd,
              dueOn: tax.dueOn,
              fileOn: tax.late ? new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }) : tax.dueOn,
              late: tax.late,
              lines: tax.lines,
              pageCount: ready.pageCount,
              scheduleIncluded: district > 0 && !ready.warning,
            });
          } catch (err) {
            console.error('sales tax form export', err);
          }
        }
        if (!cancelled) setExportFiles({ excel, pdf, taxPdf, worksheet: taxWorksheet });
      } catch (e) {
        if (!cancelled) console.error('export prep', e);
      } finally { if (!cancelled) setExportsPreparing(false); }
    })();
    return () => { cancelled = true; };
  }, [client, workbook, selected, viewPeriod, money, span, slices]);

  useEffect(() => {
    if (!native || !onNativeNavigation) return;
    onNativeNavigation(false, 'Reports');
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
    document.getElementById('floor-location-print-style')?.remove();
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
        const filled = await fillCdtfaPdfBytes(template, paperToCdtfaDoc(tax));
        const district = tax.lines.find((line) => line.id === '16')?.dollars ?? 0;
        const ready = await officialCdtfaPdf(filled, district);
        const formPdf = ready.bytes;
        const worksheet = await buildCdtfaWorksheet({
          periodStart: tax.periodStart,
          periodEnd: tax.periodEnd,
          dueOn: tax.dueOn,
          fileOn: tax.late ? new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }) : tax.dueOn,
          late: tax.late,
          lines: tax.lines,
          pageCount: ready.pageCount,
          scheduleIncluded: district > 0 && !ready.warning,
        });
        const pdf = await appendPdf(reportPdf, formPdf);
        files.push({ name: `${item.title.replace(/\s+/g, '-')}.pdf`, bytes: pdf });
        files.push({ name: cdtfaPdfFileName(item.start, item.end), bytes: formPdf });
        files.push({ name: `CDTFA-worksheet_${item.start.slice(0, 7)}_Open-Box-Industries.pdf`, bytes: worksheet });
        addArchiveSheet(book, item.title, workbook, tax);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not export every period.');
    } finally {
      setArchiveBusy(false);
    }
  }

  const fileStem = viewPeriod ? spanTitle(viewPeriod.period_start, span).replace(/\s+/g, '-') : 'Books';
  const downloadExcel = () => {
    if (!exportFiles) return;
    const xlsx = { name: `Books-${fileStem}.xlsx`, bytes: exportFiles.excel };
    if (exportFiles.taxPdf && viewPeriod) {
      const files = [
        xlsx,
        { name: cdtfaPdfFileName(viewPeriod.period_start, viewPeriod.period_end), bytes: exportFiles.taxPdf },
      ];
      if (exportFiles.worksheet) files.push({ name: `CDTFA-worksheet_${viewPeriod.period_start.slice(0, 7)}_Open-Box-Industries.pdf`, bytes: exportFiles.worksheet });
      downloadBytes(`Books-${fileStem}.zip`, zipStore(files), 'application/zip');
      return;
    }
    downloadBytes(xlsx.name, xlsx.bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };
  const downloadPdf = () => exportFiles && downloadBytes(`Books-${fileStem}.pdf`, exportFiles.pdf, 'application/pdf');

  function patchReports(patcher: (current: Report) => Report) {
    setParts((prev) => prev.map((part) => ({ ...part, report: patcher(part.report) })));
    setReport((prev) => (prev ? patcher(prev) : prev));
  }

  async function resolveLabel(expenseId: string, choice: { saleId?: string; asExpense?: boolean }) {
    const { error: rpcError } = await client.rpc('portal_books_resolve_label', {
      p_expense: expenseId,
      p_sale_id: choice.saleId ? Number(choice.saleId) : null,
      p_as_expense: !!choice.asExpense,
    });
    if (rpcError) {
      setError(rpcError.message || 'Could not update that label.');
      return;
    }
    patchReports((current) => {
      const sales = (current.sales || []).map((row) => ({ ...row }));
      const expenses = (current.expenses || []).map((row) => {
        if (String(row.id) !== expenseId) return row;
        if (choice.asExpense) return { ...row, source: 'manual', sale_id: null };
        const sale = sales.find((item) => String(item.id) === String(choice.saleId));
        return { ...row, sku: sale?.sku || row.sku, sale_id: choice.saleId };
      });
      if (!choice.asExpense) {
        const expense = (current.expenses || []).find((row) => String(row.id) === expenseId);
        const cents = Number(expense?.amount_cents || 0);
        const idx = sales.findIndex((row) => String(row.id) === String(choice.saleId));
        if (idx >= 0 && cents > 0) {
          const already = Number(sales[idx].ship_cost_cents || 0);
          if (already < cents) {
            const added = cents - already;
            sales[idx].ship_cost_cents = already + added;
            if (sales[idx].profit_cents != null) sales[idx].profit_cents = Number(sales[idx].profit_cents) - added;
          }
        }
      }
      return {
        ...current,
        sales: sales as Row[],
        expenses,
        books_unmatched_labels: (current.books_unmatched_labels || []).filter((row) => row.id !== expenseId),
      };
    });
  }

  const reportToday = new Date();
  const firstSalesYear = periods.reduce((year, row) => Math.min(year, Number(row.period_start.slice(0, 4)) || year), reportToday.getFullYear());
  const yearChoices = yearsFrom(firstSalesYear, reportToday);
  const choices = periodChoices(reportYear, reportToday);

  function remember(nextYear: number, nextPick: string) {
    sessionStorage.setItem('floor-reports-year', String(nextYear));
    sessionStorage.setItem('floor-reports-pick', nextPick);
    const next = choiceBounds(nextYear, nextPick);
    setSpan(next.span);
    const match = periods.find((row) => row.period_start >= next.start && row.period_start <= next.end);
    if (match) setPeriodId(match.id);
  }

  async function emptyWorkbook() {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Sales');
    sheet.addRow(['No sales this month']);
    const out = await book.xlsx.writeBuffer();
    return new Uint8Array(out);
  }

  async function taxForSelection() {
    const bounds = choiceBounds(reportYear, reportPick);
    const ranges = bounds.span === 'quarter' ? monthsInRange(bounds.start, bounds.end).map((month) => spanBounds(month, 'month')) : [bounds];
    const accountRes = await client.rpc('portal_cdtfa_account');
    const account = accountRes.error ? '' : String(accountRes.data || '');
    const parts: Uint8Array[] = [];
    for (const range of ranges) {
      const model = await loadCdtfaPrintModel(client, range.start, range.end);
      const filled = await fillCdtfaPdfBytes(await loadCdtfaTemplate(), paperToCdtfaDoc({
        periodStart: range.start,
        periodEnd: range.end,
        dueOn: model?.dueOn || dueOn(range.end),
        lines: model?.lines || [],
        open: false,
        preparer: '',
        omitInterest: model?.omitInterest ?? false,
        signer: { account },
      }));
      const district = model?.lines.find((line) => line.id === '16')?.dollars ?? 0;
      parts.push((await officialCdtfaPdf(filled, district)).bytes);
    }
    return parts.length > 1 ? mergePdfBytes(parts) : parts[0];
  }

  async function pageCount(bytes: Uint8Array) {
    const { PDFDocument } = await import('pdf-lib');
    return (await PDFDocument.load(bytes)).getPageCount();
  }

  async function runFile(kind: '' | 'sheet' | 'tax' | 'view-sheet' | 'view-tax' | 'full') {
    const view = kind === 'view-sheet' || kind === 'view-tax';
    const popup = view ? window.open('about:blank', '_blank') : null;
    setFileBusy(kind);
    setFileError('');
    try {
      const stem = reportFileStem(reportYear, reportPick);
      if (kind === 'full') {
        const bytes = new Uint8Array(await loadCdtfaTemplate());
        downloadBytes('CDTFA-401-A-full.pdf', bytes, 'application/pdf');
        return;
      }
      if (kind === 'sheet' || kind === 'view-sheet') {
        const excel = exportFiles?.excel ?? await emptyWorkbook();
        if (kind === 'view-sheet') await showSpreadsheet(popup, excel, `${stem}.xlsx`);
        else downloadBytes(`${stem}.xlsx`, excel, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        return;
      }
      const taxPdf = exportFiles?.taxPdf ?? await taxForSelection();
      if (!taxPdf) throw new Error('missing');
      const pages = await pageCount(taxPdf);
      const name = `${stem}-${pages}-pages.pdf`;
      if (kind === 'view-tax') {
        const url = URL.createObjectURL(new Blob([new Uint8Array(taxPdf)], { type: 'application/pdf' }));
        if (popup && !popup.closed) popup.location.href = url;
        else window.location.href = url;
      } else downloadBytes(name, taxPdf, 'application/pdf');
    } catch {
      if (popup && !popup.closed) popup.close();
      setFileError("Couldn't build the report. Try again.");
    } finally {
      setFileBusy('');
    }
  }

  return (
    <div className={`books-page${native ? ' books-native' : ''}`}>
      <ReportsHome
        year={reportYear}
        years={yearChoices}
        onYear={(year) => { setReportYear(year); remember(year, reportPick); }}
        pick={reportPick}
        choices={choices}
        onPick={(id) => { const row = choices.find((item) => item.id === id); if (row?.disabled) return; setReportPick(id); remember(reportYear, id); }}
        busy={fileBusy || (exportsPreparing ? 'sheet' : '')}
        error={fileError || error}
        onSheet={() => void runFile('sheet')}
        onTax={() => void runFile('tax')}
        onViewSheet={() => void runFile('view-sheet')}
        onViewTax={() => void runFile('view-tax')}
        onFull={() => void runFile('full')}
      />
    </div>
  );
}
