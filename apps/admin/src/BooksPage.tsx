import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

type Period = { id: string; period_type: 'month' | 'week'; period_start: string; period_end: string; status: 'draft' | 'ready' | 'locked'; locked_at: string | null };
type Row = Record<string, unknown>;
type Report = { period: Period; checks: Check[]; sales: Row[]; fees: Row[]; labels: Row[]; expenses: Row[]; returns: Row[]; dispositions: Row[]; inventory_bought: Row[]; manifests: Row[]; payouts: Row[]; payout_balances: Row[]; payments: Row[]; adjustments: Row[]; prior_corrections: Row[]; withdrawals: Row[]; money_trail: Row[] };
type Check = { key: string; label: string; ok: boolean; count: number; detail: string; explanation: string | null };
type Snapshot = { captured_on: string; boundary: string; unit_count: number; cost_value_cents: number };
type Opening = { source: string; effective_on: string; amount_cents: number; note: string };
type Props = { client: SupabaseClient; money: (cents: number) => string; native?: boolean };

const SOURCES = ['safe', 'square', 'ebay', 'depop', 'website', 'amazon', 'tiktok'];
const SOURCE_LABEL: Record<string, string> = { safe: 'Safe cash', square: 'Square', ebay: 'eBay', depop: 'Depop', website: 'Website', amazon: 'Amazon', tiktok: 'TikTok' };
const SECTIONS = [
  ['summary', 'Summary'], ['sales', 'Sales · accrual'], ['fees', 'Fees'], ['labels', 'Shipping'], ['returns', 'Refunds, returns & dispositions'],
  ['expenses', 'Expenses'], ['inventory_bought', 'Inventory bought'], ['payouts', 'Payouts earned'], ['payments', 'Payout payments & adjustments'],
  ['withdrawals', 'Withdrawals · cash view'], ['money_trail', 'Money trail'], ['pending', 'Pending / open items'], ['sales_tax', 'Sales tax'],
  ['inventory', 'Inventory snapshot'], ['reconciliation', 'Reconciliation'],
] as const;
const WEEK_SECTIONS = new Set(['summary', 'sales', 'payouts', 'payments', 'withdrawals', 'pending', 'reconciliation']);
const asDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const addDays = (s: string, n: number) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monthLabel = (s: string) => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${s}T12:00:00Z`));
const bytesBase64 = (buffer: ArrayBuffer | Uint8Array) => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer); let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
function arrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const copy = new Uint8Array(data.byteLength); copy.set(data); return copy.buffer as ArrayBuffer;
}
function download(name: string, data: ArrayBuffer | Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([arrayBuffer(data)], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
function display(value: unknown, key: string, money: (c: number) => string) {
  if (value === null || value === undefined || value === '') return '—';
  if (key.endsWith('_cents') && typeof value === 'number') return money(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function columns(rows: Row[]) {
  const preferred = ['date', 'sold_at', 'spent_on', 'sku', 'item_title', 'title', 'receipt_no', 'channel', 'price_cents', 'shipping_cents', 'final_value_fee_cents', 'promoted_fee_cents', 'payment_fee_cents', 'other_fee_cents', 'tax_cents', 'ship_cost_cents', 'cost_cents', 'cost_source', 'profit_cents', 'fees_absorbed_by_store', 'id'];
  const keys = [...new Set(rows.flatMap(Object.keys))];
  return [...preferred.filter((key) => keys.includes(key)), ...keys.filter((key) => !preferred.includes(key))];
}

export function BooksPage({ client, money, native = false }: Props) {
  const [mode, setMode] = useState<'month' | 'week'>('month');
  const [periods, setPeriods] = useState<Period[]>([]);
  const [selected, setSelected] = useState<Period | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [openings, setOpenings] = useState<Opening[]>([]);
  const [section, setSection] = useState<string>('summary');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openForm, setOpenForm] = useState(false);
  const [openSource, setOpenSource] = useState('safe');
  const [openDate, setOpenDate] = useState('');
  const [openAmount, setOpenAmount] = useState('');
  const [openNote, setOpenNote] = useState('');
  const [correctionForm, setCorrectionForm] = useState(false);
  const [correction, setCorrection] = useState({ originalTable: '', originalId: '', source: 'safe', amount: '', description: '' });
  const [payoutForm, setPayoutForm] = useState(false);
  const [payout, setPayout] = useState({ source: 'ebay', payoutId: '', amount: '', date: '', bankReference: '', note: '' });

  const loadPeriods = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_books_list', { p_from: '2026-01-01', p_to: asDate(new Date()) });
    if (e) throw e;
    setPeriods((data || []) as Period[]);
  }, [client]);
  useEffect(() => { void loadPeriods().catch((e) => setError(e.message || String(e))); }, [loadPeriods]);

  const loadPeriod = useCallback(async (p: Period) => {
    setBusy(true); setError(''); setSelected(p); setSection('summary'); setReport(null);
    try {
      const [r, s, b] = await Promise.all([
        client.rpc('portal_books_report', { p_period: p.id }),
        client.from('books_inventory_snapshots').select('captured_on,boundary,unit_count,cost_value_cents').gte('captured_on', p.period_start).lte('captured_on', p.period_end),
        client.from('books_opening_balances').select('source,effective_on,amount_cents,note').lte('effective_on', p.period_start).order('effective_on', { ascending: false }),
      ]);
      if (r.error) throw r.error; if (s.error) throw s.error; if (b.error) throw b.error;
      const { data: status, error: statusError } = await client.rpc('portal_books_refresh_readiness', { p_period: p.id });
      if (statusError) throw statusError;
      const next = { ...(r.data as Report), period: { ...(r.data as Report).period, status: status as Period['status'] } };
      setReport(next); setSelected({ ...p, status: status as Period['status'] }); setSnapshots((s.data || []) as Snapshot[]); setOpenings((b.data || []) as Opening[]);
      void loadPeriods();
    } catch (e) { setError((e as Error).message || String(e)); }
    finally { setBusy(false); }
  }, [client]);

  const makePeriod = async (type: 'month' | 'week', start: string, end: string) => {
    const { data, error: e } = await client.rpc('portal_books_ensure_period', { p_type: type, p_start: start, p_end: end });
    if (e) throw e;
    const p: Period = { id: data, period_type: type, period_start: start, period_end: end, status: 'draft', locked_at: null };
    return p;
  };
  const cards = useMemo(() => {
    const today = asDate(new Date());
    if (mode === 'month') {
      const currentMonth = new Date(`${today}T12:00:00Z`); currentMonth.setUTCDate(1);
      return Array.from({ length: 24 }, (_, i) => {
        const d = new Date(currentMonth); d.setUTCMonth(d.getUTCMonth() - i); const start = d.toISOString().slice(0, 10);
        const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
        return periods.find((p) => p.period_type === 'month' && p.period_start === start) || { id: '', period_type: 'month' as const, period_start: start, period_end: end, status: 'draft' as const, locked_at: null };
      });
    }
    const mondayOffset = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
    const start = addDays(today, -mondayOffset);
    return Array.from({ length: 12 }, (_, i) => {
      const s = addDays(start, -7 * i); const existing = periods.find((p) => p.period_type === 'week' && p.period_start === s);
      return existing || { id: '', period_type: 'week' as const, period_start: s, period_end: addDays(s, 6), status: 'draft' as const, locked_at: null };
    });
  }, [mode, periods]);

  const totals = useMemo(() => {
    const sales = report?.sales || []; const channels = new Map<string, { revenue: number; fees: number; cost: number; profit: number; tax: number; count: number; paul: number; jacob: number; shipping: number }>();
    for (const row of sales) {
      const raw = String(row.channel || 'other').toLowerCase(); const ch = ['floor','in_store','instore'].includes(raw) ? 'in_store' : raw; const item = channels.get(ch) || { revenue: 0, fees: 0, cost: 0, profit: 0, tax: 0, count: 0, paul: 0, jacob: 0, shipping: 0 };
      item.revenue += Number(row.price_cents || 0) + Number(row.shipping_cents || 0); item.fees += Number(row.channel_fee_cents || 0) + Number(row.processing_fee_cents || 0);
      item.cost += Number(row.cost_cents || 0); item.profit += Number(row.profit_cents || 0); item.tax += Number(row.tax_collected_cents ?? row.tax_cents ?? 0); item.count += Number(row.qty || 1); item.paul += Number(row.paul_commission_cents || 0); item.jacob += Number(row.jacob_commission_cents || 0); item.shipping += Number(row.ship_cost_cents || 0); channels.set(ch, item);
    }
    const expense = (report?.expenses || []).filter((r) => !r.voided_at).reduce((n, r) => n + Number(r.amount_cents || 0), 0);
    const commission = (report?.payouts || []).reduce((n, r) => n + Number(r.amount_cents || 0), 0);
    const platformDeposits = (report?.withdrawals || []).filter((r) => !r.voided_at && r.payout_id && Number(r.amount_cents) > 0).reduce((n, r) => n + Number(r.amount_cents || 0), 0);
    const employeePayments = (report?.payments || []).reduce((n, r) => n + Number(r.amount_cents || 0), 0);
    return { channels: [...channels.entries()].sort(([a], [b]) => a.localeCompare(b)), revenue: sales.reduce((n, r) => n + Number(r.price_cents || 0) + Number(r.shipping_cents || 0), 0), fees: sales.reduce((n, r) => n + Number(r.channel_fee_cents || 0) + Number(r.processing_fee_cents || 0), 0), shipping: sales.reduce((n, r) => n + Number(r.ship_cost_cents || 0), 0), cost: sales.reduce((n, r) => n + Number(r.cost_cents || 0), 0), profit: sales.reduce((n, r) => n + Number(r.profit_cents || 0), 0), expense, commission, cashIn: sales.reduce((n, r) => n + Number(r.cash_cents || 0) + Number(r.card_cents || 0), 0), cashOut: (report?.withdrawals || []).filter((r) => !r.voided_at && typeof r.amount_cents === 'number' && Number(r.amount_cents) < 0).reduce((n, r) => n + Math.abs(Number(r.amount_cents)), 0) + expense + employeePayments, platformDeposits, tax: sales.reduce((n, r) => n + Number(r.tax_collected_cents ?? r.tax_cents ?? 0), 0) };
  }, [report]);

  const generated = useMemo<Record<string, Row[]>>(() => {
    if (!report) return {} as Record<string, Row[]>;
    const trails = report.money_trail || [];
    const pending: Row[] = [
      ...report.sales.filter((s) => s.cost_cents == null || ['default', 'builtin', 'estimated'].includes(String(s.cost_source))).map((s) => ({ id: s.id, date: s.sold_at, sku: s.sku, issue: 'Sale needs a confirmed item cost', amount_cents: s.price_cents })),
      ...report.sales.filter((s) => ['pending', 'none'].includes(String(s.fee_source)) && !['in_store', 'website', 'depop'].includes(String(s.channel))).map((s) => ({ id: s.id, date: s.sold_at, sku: s.sku, issue: 'Waiting for marketplace fees', amount_cents: s.price_cents })),
      ...report.labels.filter((l) => l.status === 'refund pending' || l.status === 'voided').map((l) => ({ id: l.id, date: l.date, issue: l.status === 'voided' ? 'Voided label · refund not requested/recorded' : 'Label refund pending', amount_cents: l.refund_amount_cents ?? l.cost_cents })),
      ...trails.filter((s) => s.status !== 'Matched').map((s) => ({ ...s, issue: s.status })),
      ...report.manifests.map((m) => ({ id: m.id, date: m.manifest_on, issue: 'Manifest total paid is not recorded; only unit-level acquisition costs may be available', amount_cents: null })),
    ];
    const reconciliation = SOURCES.map((source) => {
      const opening = openings.find((x) => x.source === source);
      const sales = report.sales.filter((s) => ['floor','in_store','instore'].includes(String(s.channel).toLowerCase()) ? source === 'safe' : String(s.channel).toLowerCase() === source).reduce((n, s) => n + Number(s.price_cents || 0) + Number(s.shipping_cents || 0) - Number(s.tax_owed_cents || 0), 0);
      const fees = report.sales.filter((s) => String(s.channel).toLowerCase() === source).reduce((n, s) => n + Number(s.channel_fee_cents || 0) + Number(s.processing_fee_cents || 0), 0);
      const withdrawals = report.withdrawals.filter((w) => w.source === source && !w.voided_at).reduce((n, w) => n + Number(w.amount_cents || 0), 0);
      return { source: SOURCE_LABEL[source], opening_balance_cents: opening?.amount_cents ?? null, recorded_sales_cents: sales, recorded_fees_cents: fees, refunds_cents: 0, withdrawals_cents: withdrawals, pending_cents: null, ending_balance_cents: null, gap_cents: null, status: opening ? 'Partial · no payout/deposit matching source' : 'Missing opening balance' };
    });
    return { money_trail: trails, pending, sales_tax: report.sales.map((s) => ({ id: s.id, date: s.sold_at, receipt_no: s.receipt_no, sku: s.sku, channel: s.channel, taxable_sales_cents: Number(s.price_cents || 0) + Number(s.shipping_cents || 0), tax_collected_cents: Number(s.tax_collected_cents ?? s.tax_cents ?? 0), tax_owed_cents: Number(s.tax_owed_cents || 0), remitted_by: s.tax_remitted_by, tax_rate: 'Not recorded by source ledger' })), inventory: snapshots.map((s) => ({ ...s, cost_value: s.cost_value_cents })), reconciliation, payments: [...report.payments, ...report.adjustments, ...report.prior_corrections.map((row) => ({ ...row, entry_type: 'Prior-month correction' }))] };
  }, [report, openings, snapshots]);

  const visibleSections = mode === 'week' ? SECTIONS.filter(([id]) => WEEK_SECTIONS.has(id)) : SECTIONS;
  const sectionRows = (key: string): Row[] => {
    if (key === 'summary') return (totals.channels || []).map(([channel, t]) => ({ channel, sale_count: t.count, revenue_including_buyer_shipping_cents: t.revenue, channel_and_payment_fees_cents: t.fees, shipping_label_cost_cents: t.shipping, cost_of_goods_cents: t.cost, profit_cents: t.profit, paul_commission_cents: t.paul, jacob_commission_cents: t.jacob, sales_tax_cents: t.tax }));
    if (key === 'sales') return report?.sales || [];
    if (key === 'fees') return report?.fees || [];
    if (key === 'labels') return report?.labels || [];
    if (key === 'returns') return [...(report?.returns || []).map((r) => ({ ...r, entry_type: 'Return/refund' })), ...(report?.dispositions || []).map((r) => ({ ...r, entry_type: 'Replacement/giveaway' }))];
    if (key === 'expenses') return report?.expenses || [];
    if (key === 'inventory_bought') return [...(report?.inventory_bought || []).map((r) => ({ ...r, entry_type: 'Unit received' })), ...(report?.manifests || []).map((r) => ({ ...r, entry_type: 'Manifest' }))];
    if (key === 'payouts') return [...(report?.payouts || []), ...(report?.payout_balances || []).map((r) => ({ ...r, entry_type: 'Period balance summary' }))];
    if (key === 'withdrawals') return report?.withdrawals || [];
    return generated[key] || [];
  };

  async function saveOpening() {
    const amount = Number(openAmount); if (!Number.isFinite(amount) || Math.round(amount * 100) !== amount * 100 || !openDate) { setError('Enter a date and an amount with no more than two decimal places.'); return; }
    setBusy(true); setError('');
    try {
      const { error: e } = await client.rpc('portal_books_save_opening', { p_source: openSource, p_on: openDate, p_amount_cents: Math.round(amount * 100), p_note: openNote });
      if (e) throw e; setOpenForm(false); setOpenAmount(''); setOpenNote(''); if (selected) await loadPeriod(selected);
    } catch (e) { setError((e as Error).message || String(e)); } finally { setBusy(false); }
  }
  async function capture(boundary: 'start' | 'end') {
    if (!selected) return;
    setBusy(true); setError('');
    try { const { error: e } = await client.rpc('portal_books_capture_inventory', { p_on: asDate(new Date()), p_boundary: boundary }); if (e) throw e; await loadPeriod(selected); }
    catch (e) { setError((e as Error).message || String(e)); } finally { setBusy(false); }
  }
  async function explain(check: Check, text: string) {
    if (!selected) return; const { error: e } = await client.rpc('portal_books_explain', { p_period: selected.id, p_check_key: check.key, p_explanation: text });
    if (e) setError(e.message); else await loadPeriod(selected);
  }
  async function labelRefund(row: Row) {
    const requested = window.prompt('Refund requested date/time (ISO date or timestamp; blank if not requested):', String(row.refund_requested_at || ''));
    if (requested === null) return;
    const amount = window.prompt('Refund amount in dollars (blank if unknown):', row.refund_amount_cents == null ? '' : (Number(row.refund_amount_cents) / 100).toFixed(2)); if (amount === null) return;
    const received = window.prompt('Refund received date/time (blank if pending):', String(row.refund_received_at || '')); if (received === null) return;
    const { error: e } = await client.rpc('portal_books_label_refund', { p_label: row.id, p_requested: requested || null, p_amount_cents: amount ? Math.round(Number(amount) * 100) : null, p_received: received || null });
    if (e) setError(e.message); else if (selected) await loadPeriod(selected);
  }

  const reportSheets = visibleSections.map(([key, label]) => ({ key, label, rows: sectionRows(key) }));
  async function buildExcel() {
    if (!report || !selected) return new ArrayBuffer(0);
    const wb = new ExcelJS.Workbook(); wb.creator = 'Floor Books'; wb.subject = `${selected.period_start} to ${selected.period_end}`;
    for (const sheet of reportSheets) {
      const ws = wb.addWorksheet(sheet.label.slice(0, 31));
      const rows = sheet.rows; const keys = columns(rows); if (!keys.length) keys.push('record');
      ws.addRow(keys.map((k) => k.replaceAll('_', ' ').replace(/\b\w/g, (x) => x.toUpperCase())));
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF253348' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }]; ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(keys.length, 1) } };
      if (!rows.length) ws.addRow(['No records this period']);
      for (const row of rows) ws.addRow(keys.map((k) => row[k] ?? ''));
      ws.addRow([]); ws.addRow(['Period totals', ...keys.slice(1).map((key) => rows.reduce((sum, row) => typeof row[key] === 'number' && (key.endsWith('_cents') || key === 'qty') ? sum + Number(row[key]) : sum, 0))]);
      ws.addRow(['Period', `${selected.period_start} through ${selected.period_end}`]);
      ws.columns = keys.map((key) => ({ key, width: Math.min(34, Math.max(12, key.length + 3)), style: key.endsWith('_cents') ? { numFmt: '$#,##0.00;[Red]-$#,##0.00' } : {} }));
      ws.eachRow((row, number) => { if (number > 1) row.eachCell((cell, col) => { const key = keys[col - 1]; if (key?.endsWith('_cents') && typeof cell.value === 'number') cell.value = cell.value / 100; else if (key && /(date|_at|_on)$/.test(key) && typeof cell.value === 'string' && !Number.isNaN(Date.parse(cell.value))) { cell.value = new Date(cell.value); cell.numFmt = key.endsWith('_at') ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd'; } }); });
    }
    return wb.xlsx.writeBuffer();
  }
  async function buildPdf() {
    const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const pageWidth = 792; const pageHeight = 612; const margin = 34; let page = pdf.addPage([pageWidth, pageHeight]); let y = pageHeight - margin; let pageNo = 1; let currentTitle = 'Summary';
    const newPage = (title = currentTitle) => { currentTitle = title || currentTitle; page = pdf.addPage([pageWidth, pageHeight]); pageNo++; y = pageHeight - margin; page.drawText('Open Box Industries · Books', { x: margin, y, size: 10, font: bold }); y -= 20; page.drawText(currentTitle, { x: margin, y, size: 14, font: bold }); y -= 22; };
    const line = (text: string, strong = false) => {
      const activeFont = strong ? bold : font; const words = String(text).split(/\s+/); let current = '';
      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (activeFont.widthOfTextAtSize(candidate, 7.5) > pageWidth - margin * 2 && current) {
          if (y < margin + 22) newPage();
          page.drawText(current, { x: margin, y, size: 7.5, font: activeFont, color: rgb(0.1, 0.13, 0.18) }); y -= 12; current = word;
        } else current = candidate;
      }
      if (current) { if (y < margin + 22) newPage(); page.drawText(current, { x: margin, y, size: 7.5, font: activeFont, color: rgb(0.1, 0.13, 0.18) }); y -= 12; }
    };
    page.drawText('Open Box Industries · Books', { x: margin, y, size: 18, font: bold }); y -= 25;
    page.drawText(`${monthLabel(selected!.period_start)} · ${selected!.period_start} to ${selected!.period_end}`, { x: margin, y, size: 11, font }); y -= 25;
    line(`Revenue ${money(totals.revenue)}   Fees ${money(totals.fees)}   Cost of goods ${money(totals.cost)}   Profit ${money(totals.profit)}`, true);
    line(`Expenses ${money(totals.expense)}   Commissions ${money(totals.commission)}   Sales tax ${money(totals.tax)}`); y -= 8;
    for (const sheet of reportSheets) {
      newPage(sheet.label); const rows = sheet.rows; if (!rows.length) { line('No records in this period.'); continue; }
      const keys = columns(rows);
      for (const row of rows) {
        for (const key of keys) line(`${key.replaceAll('_', ' ')}: ${display(row[key], key, money)}`);
        line('');
      }
    }
    const pages = pdf.getPages(); pages.forEach((p, i) => p.drawText(`Page ${i + 1} of ${pages.length} · ${selected!.period_start}–${selected!.period_end}`, { x: margin, y: 14, size: 8, font }));
    return pdf.save();
  }
  async function exportFile(format: 'excel' | 'pdf') {
    if (!report || !selected) return;
    if (selected.status === 'locked') {
      const { data, error: e } = await client.rpc('portal_books_frozen_export', { p_period: selected.id, p_format: format });
      if (e) { setError(e.message); return; }
      const binary = atob(data); const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      download(`Books-${selected.period_start}.${format === 'excel' ? 'xlsx' : 'pdf'}`, bytes, format === 'excel' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf'); return;
    }
    const buffer = format === 'excel' ? await buildExcel() : await buildPdf();
    download(`Books-${selected.period_start}.${format === 'excel' ? 'xlsx' : 'pdf'}`, buffer, format === 'excel' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf');
  }
  async function finalize() {
    if (!report || !selected || !window.confirm(`Lock ${selected.period_start}–${selected.period_end}? This freezes the report and blocks dated edits.`)) return;
    setBusy(true); setError('');
    try {
      const [excel, pdf] = await Promise.all([buildExcel(), buildPdf()]);
      const { error: e } = await client.rpc('portal_books_finalize', { p_period: selected.id, p_report: report, p_excel_base64: bytesBase64(excel), p_pdf_base64: bytesBase64(pdf) });
      if (e) throw e; await loadPeriods(); await loadPeriod({ ...selected, status: 'locked', locked_at: new Date().toISOString() });
    } catch (e) { setError((e as Error).message || String(e)); } finally { setBusy(false); }
  }
  async function unlock() {
    if (!selected) return; const reason = window.prompt('Required reason to unlock this closed month (at least 8 characters):'); if (!reason) return;
    const { error: e } = await client.rpc('portal_books_unlock', { p_period: selected.id, p_reason: reason }); if (e) setError(e.message); else { await loadPeriods(); await loadPeriod({ ...selected, status: 'ready', locked_at: null }); }
  }
  async function saveCorrection() {
    if (!selected || !correction.originalTable.trim() || !correction.originalId.trim() || !correction.description.trim() || !correction.amount || Number.isNaN(Number(correction.amount))) { setError('Fill in the original record, source, amount, and correction reason.'); return; }
    setBusy(true); setError('');
    try {
      const { error: e } = await client.rpc('portal_books_prior_correction', { p_on: asDate(new Date()), p_original_table: correction.originalTable, p_original_id: correction.originalId, p_source: correction.source, p_amount_cents: Math.round(Number(correction.amount) * 100), p_description: correction.description });
      if (e) throw e; setCorrectionForm(false); setCorrection({ originalTable: '', originalId: '', source: 'safe', amount: '', description: '' }); await loadPeriod(selected);
    } catch (e) { setError((e as Error).message || String(e)); } finally { setBusy(false); }
  }
  async function savePayout() {
    const amount = Number(payout.amount);
    if (!payout.payoutId.trim() || !payout.date || !Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) { setError('Enter a payout ID, date, and amount with up to two decimal places.'); return; }
    setBusy(true); setError('');
    try {
      const { error: e } = await client.rpc('portal_books_record_platform_payout', { p_source: payout.source, p_payout_id: payout.payoutId, p_amount_cents: Math.round(amount * 100), p_paid_on: payout.date, p_bank_reference: payout.bankReference, p_note: payout.note });
      if (e) throw e; setPayoutForm(false); setPayout({ source: 'ebay', payoutId: '', amount: '', date: '', bankReference: '', note: '' }); if (selected) await loadPeriod(selected);
    } catch (e) { setError((e as Error).message || String(e)); } finally { setBusy(false); }
  }
  async function linkSalePayout(row: Row) {
    const channel = String(row.channel || '').toLowerCase();
    const isSquareCard = ['in_store','instore','floor'].includes(channel) && ['card','split'].includes(String(row.payment_method || '').toLowerCase());
    if (['in_store','instore','floor'].includes(channel) && !isSquareCard) { setError('Cash register sales are reconciled against the safe count, not a platform payout.'); return; }
    const source = channel === 'website' || isSquareCard ? 'square' : channel;
    if (!['square','ebay','depop','amazon','tiktok'].includes(source)) { setError('This sale channel does not use a separate platform payout link.'); return; }
    const payoutId = window.prompt(`Platform payout ID for sale ${row.receipt_no || row.sale_id || row.id}:`, String(row.payout_id || ''));
    if (!payoutId?.trim()) return;
    const { error: e } = await client.rpc('portal_books_link_sale_payout', { p_sale_id: Number(row.sale_id ?? row.id), p_source: source, p_payout_id: payoutId, p_note: '' });
    if (e) setError(e.message); else if (selected) await loadPeriod(selected);
  }
  async function linkBankReference(row: Row) {
    const reference = window.prompt(`Bank deposit/reference for payout ${row.payout_id || row.id}:`, String(row.bank_reference || ''));
    if (reference === null) return;
    const { error: e } = await client.rpc('portal_books_link_bank_reference', { p_withdrawal: row.id, p_reference: reference });
    if (e) setError(e.message); else if (selected) await loadPeriod(selected);
  }

  const periodStatus = (p: Period) => p.status === 'locked' ? 'Locked' : p.status === 'ready' ? 'Ready to close' : 'Draft';
  return <div className={`books-page${native ? ' books-native' : ''}`}>
    {!native && <header><div><div className="eyebrow">ACCOUNTING</div><h1>Books</h1><p>Period reports, close checks and frozen month-end records.</p></div></header>}
    {error && <div className="alert" role="alert">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></div>}
    {!selected ? <>
      <div className="books-toolbar"><div className="inventory-tabs" role="tablist" aria-label="Book periods"><button type="button" aria-selected={mode === 'month'} className={mode === 'month' ? 'active' : ''} onClick={() => setMode('month')}>Monthly</button><button type="button" aria-selected={mode === 'week'} className={mode === 'week' ? 'active' : ''} onClick={() => setMode('week')}>Weekly</button></div></div>
      <div className="books-period-grid">{cards.map((p) => <button type="button" className="books-period-card" key={`${p.period_type}:${p.period_start}`} disabled={busy} onClick={async () => { try { const loaded = p.id ? p : await makePeriod(p.period_type, p.period_start, p.period_end); if (!p.id) await loadPeriods(); await loadPeriod(loaded); } catch (e) { setError((e as Error).message || String(e)); } }}>
        <span className={`books-status ${p.status}`}>{periodStatus(p)}</span><strong>{p.period_type === 'month' ? monthLabel(p.period_start) : `${p.period_start} – ${p.period_end}`}</strong><small>{p.period_start} to {p.period_end}</small><span className="books-period-arrow">›</span>
      </button>)}</div>
    </> : <>
      <div className="books-detail-head"><button type="button" className="secondary" onClick={() => { setSelected(null); setReport(null); void loadPeriods(); }}>‹ All periods</button><div><span className={`books-status ${selected.status}`}>{periodStatus(selected)}</span><h2>{selected.period_type === 'month' ? monthLabel(selected.period_start) : `${selected.period_start} – ${selected.period_end}`}</h2><small>{selected.period_start} through {selected.period_end}</small></div><div className="books-export-actions"><button type="button" className="secondary" disabled={!report || busy} onClick={() => void exportFile('excel')}>Download Excel</button><button type="button" className="secondary" disabled={!report || busy} onClick={() => void exportFile('pdf')}>Download PDF</button></div></div>
      {busy && <p>Loading books…</p>}{report && <>
        {section === 'summary' && <><div className="books-metrics">{[['Revenue incl. buyer shipping',totals.revenue],['Fees',totals.fees],['Shipping labels',totals.shipping],['Cost of goods',totals.cost],['Profit',totals.profit],['Expenses',totals.expense],['Commissions',totals.commission],['Register cash/card tender',totals.cashIn],['Platform deposits to bank',totals.platformDeposits],['Recorded outflow',totals.cashOut],['Sales tax',totals.tax]].map(([label, value]) => <div key={String(label)}><small>{label}</small><strong>{money(Number(value))}</strong></div>)}</div><div className="books-section-title"><h3>By channel</h3><p>Revenue includes buyer-paid shipping. The cash view separately shows register tender, platform bank deposits, expenses and payout payments.</p></div></>}
        {section === 'summary' && <DataTable rows={sectionRows(section)} money={money} />}
        {section === 'checks' && <section className="panel books-checks"><h3>Close checklist</h3>{report.checks.map((c) => <div className="books-check" key={c.key}><div><strong className={c.ok ? 'ok' : 'not-ok'}>{c.ok ? '✓' : '!'}</strong><span>{c.label}<small>{c.detail}{!c.ok && c.count ? ` · ${c.count} line(s)` : ''}</small></span></div>{!c.ok && selected.status !== 'locked' && <label>Explanation for close<textarea defaultValue={c.explanation || ''} placeholder="Explain why this remains open or how it is carried forward." onBlur={(e) => { if (e.target.value.trim() && e.target.value !== c.explanation) void explain(c, e.target.value); }} /></label>}{c.explanation && <p className="books-explanation">{c.explanation}</p>}</div>)}</section>}
        {section === 'inventory' && <div className="books-snapshot-actions"><p>Snapshots store exact units and recorded acquisition costs at the time you capture them. Historical dates cannot be reconstructed from today's inventory rows. Start/end capture is enabled only on the matching period boundary.</p><button type="button" className="secondary" disabled={busy || selected.status === 'locked' || selected.period_start !== asDate(new Date())} onClick={() => void capture('start')}>Capture start snapshot today</button><button type="button" className="secondary" disabled={busy || selected.status === 'locked' || selected.period_end !== asDate(new Date())} onClick={() => void capture('end')}>Capture end snapshot today</button></div>}
        {section === 'reconciliation' && <><div className="books-opening-actions"><button type="button" className="secondary" disabled={busy || selected.status === 'locked'} onClick={() => { setOpenDate(selected.period_start); setOpenForm((x) => !x); }}>Add opening balance</button><button type="button" className="secondary" disabled={busy || selected.status === 'locked'} onClick={() => { setOpenSource('safe'); setOpenDate(selected.period_end); setOpenForm((x) => !x); }}>Record end-of-month safe count</button><button type="button" className="secondary" disabled={busy || selected.status === 'locked'} onClick={() => setCorrectionForm((x) => !x)}>Prior-month correction</button>{openForm && <div className="books-opening-form"><label>Source<select value={openSource} onChange={(e) => setOpenSource(e.target.value)}>{SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select></label><label>As of<input type="date" value={openDate} onChange={(e) => setOpenDate(e.target.value)} /></label><label>Balance ($)<input type="number" step="0.01" value={openAmount} onChange={(e) => setOpenAmount(e.target.value)} /></label><label>Note<input value={openNote} onChange={(e) => setOpenNote(e.target.value)} /></label><button type="button" disabled={busy} onClick={() => void saveOpening()}>Save balance</button></div>}{correctionForm && <div className="books-opening-form"><label>Original table<input value={correction.originalTable} onChange={(e) => setCorrection({ ...correction, originalTable: e.target.value })} placeholder="sales" /></label><label>Original record ID<input value={correction.originalId} onChange={(e) => setCorrection({ ...correction, originalId: e.target.value })} /></label><label>Source<select value={correction.source} onChange={(e) => setCorrection({ ...correction, source: e.target.value })}>{SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select></label><label>Correction amount ($)<input type="number" step="0.01" value={correction.amount} onChange={(e) => setCorrection({ ...correction, amount: e.target.value })} /></label><label>Reason<input value={correction.description} onChange={(e) => setCorrection({ ...correction, description: e.target.value })} /></label><button type="button" disabled={busy} onClick={() => void saveCorrection()}>Save prior-month correction</button></div>}</div><p className="books-caveat">The reconciliation gap stays open until each source has a verified opening balance, payout-to-bank matches, and pending amounts accounted for. No amount is inferred. Tax rate is not currently stored in the source ledger.</p></>}
        {section === 'labels' && <p className="books-caveat">Refund-request, refund-amount and refund-received dates are recorded separately. Update a row to carry a label refund forward or resolve it.</p>}
        {section === 'withdrawals' && <div className="books-opening-actions"><button type="button" className="secondary" disabled={busy || selected.status === 'locked'} onClick={() => { setPayout({ ...payout, date: selected.period_start }); setPayoutForm((x) => !x); }}>Record imported platform payout</button>{payoutForm && <div className="books-opening-form"><label>Platform<select value={payout.source} onChange={(e) => setPayout({ ...payout, source: e.target.value })}>{SOURCES.filter((s) => s !== 'safe').map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select></label><label>Payout ID<input value={payout.payoutId} onChange={(e) => setPayout({ ...payout, payoutId: e.target.value })} /></label><label>Amount ($)<input type="number" step="0.01" value={payout.amount} onChange={(e) => setPayout({ ...payout, amount: e.target.value })} /></label><label>Paid date<input type="date" value={payout.date} onChange={(e) => setPayout({ ...payout, date: e.target.value })} /></label><label>Bank reference<input value={payout.bankReference} onChange={(e) => setPayout({ ...payout, bankReference: e.target.value })} /></label><label>Note<input value={payout.note} onChange={(e) => setPayout({ ...payout, note: e.target.value })} /></label><button type="button" disabled={busy} onClick={() => void savePayout()}>Save payout record</button></div>}</div>}
        {section !== 'summary' && <DataTable rows={sectionRows(section)} money={money} onLabelRefund={section === 'labels' && selected.status !== 'locked' ? labelRefund : undefined} onLinkSale={section === 'sales' && selected.status !== 'locked' ? linkSalePayout : undefined} onLinkBank={section === 'withdrawals' && selected.status !== 'locked' ? linkBankReference : undefined} />}
        <div className="books-section-nav">{visibleSections.map(([key, label]) => <button type="button" key={key} className={section === key ? 'active' : ''} onClick={() => setSection(key)}>{label}</button>)}<button type="button" className={section === 'checks' ? 'active' : ''} onClick={() => setSection('checks')}>Close checklist</button></div>
        {selected.status === 'locked' ? <div className="books-lock-footer"><span>Frozen exports are stored with this locked report.</span><button type="button" className="secondary" onClick={() => void unlock()}>Unlock with reason</button></div> : <div className="books-lock-footer"><span>{report.checks.filter((c) => !c.ok && !c.explanation).length ? 'Resolve each check or add a written explanation before locking.' : 'The month is ready for your review.'}</span><button type="button" disabled={busy || selected.period_type !== 'month'} onClick={() => void finalize()}>Finalize month</button></div>}
      </>}
    </>}
  </div>;
}

function DataTable({ rows, money, onLabelRefund, onLinkSale, onLinkBank }: { rows: Row[]; money: (cents: number) => string; onLabelRefund?: (row: Row) => void; onLinkSale?: (row: Row) => void; onLinkBank?: (row: Row) => void }) {
  if (!rows.length) return <div className="panel books-empty">No rows recorded for this period.</div>;
  const keys = columns(rows);
  return <div className="books-table-wrap"><table className="books-table"><thead><tr>{keys.map((k) => <th key={k}>{k.replaceAll('_',' ')}</th>)}{onLabelRefund && <th>Refund tracking</th>}{onLinkSale && <th>Payout link</th>}{onLinkBank && <th>Bank match</th>}</tr></thead><tbody>{rows.map((row, i) => <tr key={String(row.id || i)}>{keys.map((k) => <td key={k}>{display(row[k], k, money)}</td>)}{onLabelRefund && <td><button type="button" className="secondary" onClick={() => onLabelRefund(row)}>Update refund</button></td>}{onLinkSale && <td><button type="button" className="secondary" onClick={() => onLinkSale(row)}>{row.payout_id ? 'Change payout ID' : 'Link payout ID'}</button></td>}{onLinkBank && <td><button type="button" className="secondary" onClick={() => onLinkBank(row)}>{row.bank_reference ? 'Edit bank reference' : 'Add bank reference'}</button></td>}</tr>)}</tbody></table></div>;
}
