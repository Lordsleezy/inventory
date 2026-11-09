import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BookTotals, BooksWorkbook, ExpenseDisplayLine, InventorySummary, Period, ReceivedItem, Report, Row, SalesLine } from './types';
import { groupExpensesByCategory, groupReceivedByDay, receivedMonthStats } from './workbook';
import { monthLabel } from './booksMath';
import { periodPickerLabel, periodStatusLabel, periodUiStatus } from './periodStatus';
import { saleWhyLines } from './saleNotes';
import { liveListedChannels, notListedLines } from './sheetChannels';
import { BooksLock } from './BooksLock';
import { CdtfaPaper } from './CdtfaPaper';
import { CdtfaReturn } from './CdtfaReturn';
import type { CdtfaPrintModel } from './cdtfaLoad';
import { spanTitle, type BooksSpan } from './booksSpan';
import type { BooksSlice } from './combineBooks';
import type { CdtfaFrequency } from './cdtfaResolve';
import { BooksIconExpenses, BooksIconInventory, BooksIconPayouts, BooksIconReceived, BooksIconSales, BooksIconTax } from './reportIcons';
import { AppScrollTabs } from '../appMode/AppScrollTabs';
import { BooksReview } from './BooksReviewPanel';

export type Sheet = 'hub' | 'sales' | 'expenses' | 'payouts' | 'inventory' | 'received' | 'tax';

const REPORT_ROWS: { id: Sheet; title: string; sub: string; hue: string; Icon: (p: { color: string }) => ReactNode }[] = [
  { id: 'sales', title: 'Sales', sub: 'Each item sold, by SKU', hue: '#0a84ff', Icon: BooksIconSales },
  { id: 'expenses', title: 'Expenses', sub: "Money out that isn't in a sale", hue: '#ff9f0a', Icon: BooksIconExpenses },
  { id: 'payouts', title: 'Payouts', sub: "Store payouts, commissions, owner's take", hue: '#30d158', Icon: BooksIconPayouts },
  { id: 'inventory', title: 'Inventory', sub: 'Stock, giveaways, replacements, returns', hue: '#5ac8fa', Icon: BooksIconInventory },
  { id: 'received', title: 'Items received', sub: 'Everything inventoried this month', hue: '#bf5af2', Icon: BooksIconReceived },
  { id: 'tax', title: 'Sales tax return', sub: 'CDTFA-401-A for this report', hue: '#ffffff', Icon: BooksIconTax },
];

export type ViewProps = {
  native: boolean;
  money: (c: number) => string;
  period: Period;
  periods: Period[];
  periodId: string;
  setPeriodId: (id: string) => void;
  totals: BookTotals;
  workbook: BooksWorkbook;
  inventory: InventorySummary;
  report: Report;
  received: ReceivedItem[];
  sheet: Sheet;
  setSheet: (s: Sheet) => void;
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
  exportsPreparing: boolean;
  exportFiles: { excel: Uint8Array; pdf: Uint8Array } | null;
  onExcel: () => void;
  onPdf: () => void;
  onPrint: () => void;
  client: SupabaseClient;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onError: (msg: string) => void;
  onReload: () => Promise<void>;
  desktopTab: Sheet;
  setDesktopTab: (s: Sheet) => void;
  onDuplicateDecision?: (lineId: string, decision: 'keep' | 'remove') => void;
  absorbFees?: boolean;
  onlineChannels?: string[];
  lockedStaleMath?: boolean;
  lockedMonths?: string[];
  taxForm?: CdtfaPrintModel | null;
  span: BooksSpan;
  setSpan: (span: BooksSpan) => void;
  filing: CdtfaFrequency | null;
  onFiling: (frequency: CdtfaFrequency | null) => void;
  onDownloadAll?: () => void;
  archiveBusy?: boolean;
  spanOptions: { value: string; label: string }[];
  spanValue: string;
  onSpanValue: (start: string) => void;
  slices: BooksSlice[];
  spanWord: string;
  showLock: boolean;
  onResolveLabel?: (expenseId: string, choice: { saleId?: string; asExpense?: boolean }) => void;
};

export function BooksViews(props: ViewProps) {
  return props.native ? <BooksNative {...props} /> : <BooksDesktop {...props} />;
}

function uiStatus(p: ViewProps) {
  if (p.span === 'month') return periodUiStatus(p.period);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  if (p.period.period_end >= today) return 'in_progress' as const;
  if (p.period.status === 'locked') return 'locked' as const;
  return 'draft' as const;
}

function SpanSwitch({ p }: { p: ViewProps }) {
  const choice = (id: BooksSpan, label: string) => (
    <button key={id} type="button" className={p.span === id ? 'on' : ''} onClick={() => p.setSpan(id)}>{label}</button>
  );
  return (
    <div className="books-span-switch" role="group" aria-label="Report length">
      {choice('month', 'Month')}
      {choice('quarter', 'Quarter')}
      {p.filing === 'yearly' && choice('year', 'Year')}
    </div>
  );
}

function ExportMenu({ p }: { p: ViewProps }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const onPointer = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);
  const item = (label: string, disabled: boolean, run: () => void) => (
    <button type="button" role="menuitem" className="books-export-item" disabled={disabled} onClick={() => { setOpen(false); run(); }}>{label}</button>
  );
  return (
    <div className="books-export" ref={root}>
      <button type="button" className="books-export-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Export</button>
      {open && (
        <div className="books-export-list" role="menu">
          {item('Excel', !p.exportFiles || p.exportsPreparing, p.onExcel)}
          {item('PDF', !p.exportFiles || p.exportsPreparing, p.onPdf)}
          {item('Print', !p.workbook, p.onPrint)}
          {p.onDownloadAll && item(p.archiveBusy ? 'Preparing…' : 'Download all periods', !!p.archiveBusy || !p.periods.length, p.onDownloadAll)}
        </div>
      )}
    </div>
  );
}

function TaxForm({ p }: { p: ViewProps }) {
  return (
    <CdtfaReturn
      client={p.client}
      money={p.money}
      periodStart={p.period.period_start}
      periodEnd={p.period.period_end}
      onPeriod={p.onSpanValue}
      onFiling={p.onFiling}
      layout={p.native ? 'phone' : 'desk'}
    />
  );
}

function SpanParts({ p, render, compact, linesOnly, rollup }: {
  p: ViewProps;
  render: (workbook: BooksWorkbook, word: string) => ReactNode;
  compact?: boolean;
  linesOnly?: boolean;
  rollup?: boolean;
}) {
  if (p.slices.length < 2) return render(p.workbook, 'month');
  const heading = p.spanWord === 'year' ? 'Year total' : 'Quarter total';
  const totals = p.workbook.sales.totals;
  return (
    <>
      {p.slices.map((slice) => (
        <section key={slice.label} className="books-span-part">
          <h3 className="books-span-label">{slice.label}</h3>
          {compact ? (
            <p className="books-span-subtotal">
              Commissions {p.money(slice.workbook.payouts.commission_total_cents)}
              {' · '}Owner keeps {p.money(slice.workbook.payouts.owner.ownerKeeps)}
              {' · '}Expenses {p.money(slice.workbook.expenses.total_cents)}
            </p>
          ) : render(slice.workbook, 'month')}
        </section>
      ))}
      {!linesOnly && (
        <section className="books-span-part">
          <h3 className="books-span-label">{heading}</h3>
          {compact && <PayoutsBody money={p.money} workbook={p.workbook} periodWord={p.spanWord} />}
          {rollup && render(p.workbook, p.spanWord)}
          {!compact && !rollup && (
            <p className="books-span-subtotal">
              Sales {p.money(totals.revenue)} · Profit {p.money(totals.profit)} · Commissions {p.money(totals.commission)} · Expenses {p.money(p.workbook.expenses.total_cents)} · Owner keeps {p.money(p.workbook.payouts.owner.ownerKeeps)}
            </p>
          )}
        </section>
      )}
      {linesOnly && <p className="books-span-subtotal">{heading}: {p.workbook.received.length} items received · {p.workbook.manifested_units || 0} manifested</p>}
    </>
  );
}

const PHONE_TABS: { id: Sheet; title: string }[] = [
  { id: 'sales', title: 'Sales' },
  { id: 'expenses', title: 'Expenses' },
  { id: 'payouts', title: 'Payouts' },
  { id: 'inventory', title: 'Stock' },
  { id: 'received', title: 'Received' },
  { id: 'tax', title: 'Tax' },
];

function BooksNative(p: ViewProps) {
  const ui = uiStatus(p);
  const tab: Sheet = p.sheet === 'hub' ? 'sales' : p.sheet;
  const [focusIds, setFocusIds] = useState<string[]>([]);
  return (
    <div className="native-report-body books-phone">
      <div className="books-phone-period">
        <SpanSwitch p={p} />
        <label>
          <span className="sr">Report period</span>
          <select aria-label="Report period" value={p.spanValue} onChange={(e) => p.onSpanValue(e.target.value)}>
            {p.spanOptions.map((row) => (
              <option key={row.value} value={row.value}>{row.value === p.spanValue ? `${row.label} · ${periodStatusLabel(ui)}` : row.label}</option>
            ))}
          </select>
        </label>
      </div>
      <BooksReview
        workbook={p.workbook}
        report={p.report}
        money={p.money}
        client={p.client}
        onResolveLabel={p.onResolveLabel}
        onOpen={(sheet, ids) => { p.setSheet(sheet); setFocusIds(ids); }}
      />
      <BooksDeskStrip money={p.money} totals={p.totals} />
      <AppScrollTabs ariaLabel="Books reports" className="books-phone-tabs" items={PHONE_TABS.map((item) => ({ id: item.id, label: item.title }))} value={tab} onChange={(id) => p.setSheet(id)} />
      {tab === 'sales' && <PhoneSales money={p.money} workbook={p.workbook} focusIds={focusIds} />}
      {tab === 'expenses' && <SpanParts p={p} render={(workbook) => <ExpensesBody money={p.money} workbook={workbook} native />} />}
      {tab === 'payouts' && <SpanParts p={p} render={(workbook, word) => <PayoutsBody money={p.money} workbook={workbook} native periodWord={word} />} compact />}
      {tab === 'inventory' && <SpanParts p={p} render={(workbook, word) => <InventoryBody money={p.money} inventory={workbook.inventory} manifested={workbook.manifested_units || 0} native periodWord={word} />} rollup />}
      {tab === 'received' && <SpanParts p={p} render={(workbook) => <ReceivedBody money={p.money} items={workbook.received} manifested={workbook.manifested_units || 0} native />} linesOnly />}
      {tab === 'tax' && <TaxForm p={p} />}
      <div className="books-phone-actions">
        <ExportMenu p={p} />
        {p.showLock && ui !== 'locked' && (
          <BooksLock placement="header" client={p.client} money={p.money} period={p.period} report={p.report} inventory={p.inventory} received={p.received} workbook={p.workbook} uiStatus={ui} busy={p.busy} setBusy={p.setBusy} onError={p.onError} onReload={p.onReload} lockedStaleMath={p.lockedStaleMath} />
        )}
      </div>
      {p.showLock && ui === 'locked' && <BooksLock native client={p.client} money={p.money} period={p.period} report={p.report} inventory={p.inventory} received={p.received} workbook={p.workbook} uiStatus={ui} busy={p.busy} setBusy={p.setBusy} onError={p.onError} onReload={p.onReload} lockedStaleMath={p.lockedStaleMath} />}
      {!p.showLock && <p className="native-report-footnote">Lock each month from the Month view. This {p.spanWord}'s tax form locks when every month in it is locked.</p>}
    </div>
  );
}

function PhoneSales({ money, workbook, focusIds }: { money: (c: number) => string; workbook: BooksWorkbook; focusIds?: string[] }) {
  const order = ['ebay', 'in-store', 'depop', 'mercari', 'amazon', 'tiktok'];
  const accounts = [...workbook.sales.channelTotals].sort((a, b) => order.indexOf(channelLabel(a.channel).toLowerCase()) - order.indexOf(channelLabel(b.channel).toLowerCase()));
  return (
    <div className="books-phone-sales">
      <p className="books-account-line">
        {accounts.map((c) => <span key={c.channel}><b>{channelLabel(c.channel)}</b> {money(c.revenue_cents)}</span>)}
      </p>
      {workbook.sales.rows.map((row) => (
        <div key={row.sale_id + row.sku} id={`books-sale-${row.sale_id}`} className={`books-phone-sale${focusIds?.includes(row.sale_id) ? ' books-sale-focus' : ''}`}>
          <div>
            <strong>{row.title}</strong>
            <small>{shortDate(row.date)} · SKU {row.sku} · {channelLabel(row.channel)}</small>
          </div>
          <div>
            <b>{money(row.price_cents)}</b>
            <small>{row.profit_cents == null ? '' : `profit ${money(row.profit_cents)}`}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function BooksDesktop(p: ViewProps) {
  const ui = uiStatus(p);
  const tab = p.desktopTab === 'hub' ? 'sales' : p.desktopTab;
  const periodName = spanTitle(p.period.period_start, p.span);
  const [focusIds, setFocusIds] = useState<string[]>([]);
  return (
    <div className="books-desktop">
      <header className="books-desk-head">
        <div>
          <h1>Books</h1>
          <p>{periodName} · {periodStatusLabel(ui)}</p>
        </div>
        <div className="books-desk-actions">
          <SpanSwitch p={p} />
          <label className="books-month-picker">
            <span className="sr">{p.span === 'month' ? 'Month' : p.span === 'year' ? 'Year' : 'Quarter'}</span>
            <select aria-label="Report period" value={p.spanValue} onChange={(e) => p.onSpanValue(e.target.value)}>
              {p.spanOptions.map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}
            </select>
          </label>
          <ExportMenu p={p} />
          <div className="books-export-actions">
            {p.showLock && ui !== 'locked' && (
              <BooksLock placement="header" client={p.client} money={p.money} period={p.period} report={p.report} inventory={p.inventory} received={p.received} workbook={p.workbook} uiStatus={ui} busy={p.busy} setBusy={p.setBusy} onError={p.onError} onReload={p.onReload} lockedStaleMath={p.lockedStaleMath} />
            )}
          </div>
        </div>
      </header>
      <BooksReview
        workbook={p.workbook}
        report={p.report}
        money={p.money}
        client={p.client}
        onResolveLabel={p.onResolveLabel}
        onOpen={(sheet, ids) => { p.setDesktopTab(sheet); setFocusIds(ids); }}
      />
      <BooksDeskStrip money={p.money} totals={p.totals} />
      <nav className="books-desktop-tabs" aria-label="Books reports">
        {REPORT_ROWS.map((t) => (
          <button key={t.id} type="button" className={tab === t.id ? 'active' : ''} onClick={() => p.setDesktopTab(t.id)}>{t.title}</button>
        ))}
      </nav>
      <div className="books-desktop-panel">
        {tab === 'sales' && <SpanParts p={p} render={(workbook) => <SalesTable money={p.money} workbook={workbook} totals={workbook.sales.totals} focusIds={focusIds} />} />}
        {tab === 'expenses' && <SpanParts p={p} render={(workbook) => <ExpensesTable money={p.money} workbook={workbook} />} />}
        {tab === 'payouts' && <SpanParts p={p} render={(workbook, word) => <PayoutsBody money={p.money} workbook={workbook} periodWord={word} />} compact />}
        {tab === 'inventory' && <SpanParts p={p} render={(workbook, word) => <InventoryBody money={p.money} inventory={workbook.inventory} manifested={workbook.manifested_units || 0} periodWord={word} />} rollup />}
        {tab === 'received' && <SpanParts p={p} render={(workbook) => <ReceivedBody money={p.money} items={workbook.received} manifested={workbook.manifested_units || 0} />} linesOnly />}
        {tab === 'tax' && <TaxForm p={p} />}
      </div>
      {p.showLock && ui === 'locked' && <BooksLock client={p.client} money={p.money} period={p.period} report={p.report} inventory={p.inventory} received={p.received} workbook={p.workbook} uiStatus={ui} busy={p.busy} setBusy={p.setBusy} onError={p.onError} onReload={p.onReload} lockedStaleMath={p.lockedStaleMath} />}
      {!p.showLock && <p className="books-proof-audit">Lock each month from the Month view. This {p.spanWord}'s tax form locks when every month in it is locked.</p>}
      <div className="books-print-sheets" aria-hidden>
        <section><h2>Sales</h2><SpanParts p={p} render={(workbook) => <SalesTable money={p.money} workbook={workbook} totals={workbook.sales.totals} />} /></section>
        <section><h2>Expenses</h2><SpanParts p={p} render={(workbook) => <ExpensesTable money={p.money} workbook={workbook} />} /></section>
        <section><h2>Payouts</h2><SpanParts p={p} render={(workbook, word) => <PayoutsBody money={p.money} workbook={workbook} periodWord={word} />} compact /></section>
        <section><h2>Inventory</h2><SpanParts p={p} render={(workbook, word) => <InventoryBody money={p.money} inventory={workbook.inventory} manifested={workbook.manifested_units || 0} periodWord={word} />} rollup /></section>
        <section><h2>Items received</h2><SpanParts p={p} render={(workbook) => <ReceivedBody money={p.money} items={workbook.received} manifested={workbook.manifested_units || 0} />} linesOnly /></section>
        {p.taxForm && (
          <section>
            <h2>Sales tax return</h2>
            <CdtfaPaper {...p.taxForm} money={p.money} readOnly />
          </section>
        )}
      </div>
      <p className="books-print-hint">Prints landscape · headers repeat · no sidebar</p>
    </div>
  );
}

function Block({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={className}>{children}</div>;
}

function feePolicyLine(absorbFees?: boolean, channels?: string[]) {
  const ch = (channels?.length ? channels : ['website', 'ebay', 'depop', 'amazon', 'tiktok']).filter((c) => c.toLowerCase() !== 'mercari').join(', ');
  const owner = 'Store profit: marketplace fees on online sales are paid by the owner (in-store has none).';
  const comm = absorbFees !== false
    ? 'Commissions: store absorbs marketplace + card fees (they stay off the commission base).'
    : 'Commissions: marketplace + card fees reduce the commission base.';
  return `${owner} ${comm} Online: ${ch}.`;
}

function BooksDeskStrip({ money, totals }: { money: (c: number) => string; totals: BookTotals }) {
  const cells: { label: string; value: string; lead?: boolean }[] = [
    { label: 'Owner keeps', value: money(totals.ownerKeeps), lead: true },
    { label: 'Sales', value: money(totals.revenue) },
    { label: 'Fees', value: `−${money(totals.feesAndLabels)}` },
    { label: 'COGS', value: `−${money(totals.cost)}` },
    { label: 'Profit', value: money(totals.profit) },
    { label: 'Commissions', value: `−${money(totals.commission)}` },
    { label: 'Other exp.', value: `−${money(totals.otherExpenses)}` },
  ];
  return (
    <div className="books-desk-strip">
      {cells.map((cell) => (
        <div key={cell.label} className={cell.lead ? 'lead' : ''}>
          <span>{cell.label}</span>
          <strong>{cell.value}</strong>
        </div>
      ))}
    </div>
  );
}

function BooksExportTieBar({ workbook }: { workbook: BooksWorkbook }) {
  const issues = workbook.exportTieIssues || [];
  if (!issues.length) return null;
  return (
    <p className="books-proof-status warn" style={{ display: 'block', margin: '8px 0' }}>
      These numbers don&apos;t tie: {issues.map((i) => i.message).join(' · ')}
    </p>
  );
}

function BooksProofBar({ money, workbook }: { money: (c: number) => string; workbook: BooksWorkbook }) {
  const [open, setOpen] = useState(false);
  const integrity = workbook.integrity;
  const hasUnmatched = integrity?.issues.some((i) => i.kind === 'unmatched_label');
  const auditOnly = integrity && !integrity.ok && integrity.commissionGap_cents === 0 && integrity.ownerGap_cents === 0 && !hasUnmatched;
  const gap = integrity ? Math.max(Math.abs(integrity.commissionGap_cents), Math.abs(integrity.ownerGap_cents)) : 0;
  const owedGap = integrity?.issues.find((i) => i.kind === 'owed_paul' || i.kind === 'owed_jacob');
  if (!integrity) return null;
  const status = integrity.ok
    ? '✓ Ties to per-sale payouts'
    : hasUnmatched
      ? '⚠ Unmatched shipping label'
      : auditOnly
        ? '⚠ In-store sale with marketplace fees'
        : `✗ Off by ${money(gap || Math.abs(owedGap?.cents || 0))}`;
  return (
    <div className="books-proof-bar">
      <button type="button" className={`books-proof-status${integrity.ok ? ' ok' : ' warn'}`} onClick={() => setOpen(!open)}>
        {status}
      </button>
      {workbook.audit.length > 0 && integrity.ok && (
        <p className="books-proof-audit">⚠ In-store sale with marketplace fees — tap for detail</p>
      )}
      {open && (
        <div className="books-proof-detail">
          {integrity.issues.map((i, idx) => (
            <p key={`${i.kind}-${idx}`}>{i.message}</p>
          ))}
          {integrity.issues.length === 0 && <p>All ticket totals match the hub and Payouts tab balances.</p>}
        </div>
      )}
    </div>
  );
}

function SummaryCard({ money, totals, native, absorbFees, onlineChannels }: { money: (c: number) => string; totals: BookTotals; native?: boolean; absorbFees?: boolean; onlineChannels?: string[] }) {
  const lines = [
    { label: 'Sales', value: money(totals.revenue), className: '' },
    { label: '− Fees + labels', value: money(totals.feesAndLabels), className: 'warning-text' },
    { label: '− Cost of goods', value: money(totals.cost), className: '' },
    { label: '= Profit', value: money(totals.profit), className: 'strong' },
    { label: '− Commissions', value: money(totals.commission), className: '' },
    { label: '− Other expenses', value: money(totals.otherExpenses), className: '' },
  ];
  return (
    <div className={`books-summary-card-v2${native ? ' native' : ''}`}>
      <div className="books-summary-owner">
        <small>Owner keeps</small>
        <strong className="positive">{money(totals.ownerKeeps)}</strong>
      </div>
      <div className="books-summary-stack">
        {lines.map((row) => (
          <div key={row.label} className={`books-summary-line${row.className === 'strong' ? ' profit-line' : ''}`}>
            <span>{row.label}</span>
            <b className={row.className}>{row.value}</b>
          </div>
        ))}
      </div>
      <p className="books-fee-policy">{feePolicyLine(absorbFees, onlineChannels)}</p>
    </div>
  );
}

function MonthPickerSheet(p: ViewProps) {
  return (
    <div className="books-picker-scrim" role="presentation" onClick={() => p.setPickerOpen(false)}>
      <div className="books-picker-sheet" role="dialog" aria-label="Pick a period" onClick={(e) => e.stopPropagation()}>
        <div className="books-picker-head">
          <strong>Pick a {p.span}</strong>
          <button type="button" onClick={() => p.setPickerOpen(false)}>Done</button>
        </div>
        <div className="native-report-group">
          {p.spanOptions.map((row) => {
            const selected = row.value === p.spanValue;
            return (
              <button key={row.value} type="button" className={`native-report-row books-picker-row${selected ? ' selected' : ''}`} onClick={() => { p.onSpanValue(row.value); p.setPickerOpen(false); }}>
                <span>{row.label}</span>
                <b>{selected ? '✓' : ''}</b>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SalesBody({ money, workbook, report, native }: { money: (c: number) => string; workbook: BooksWorkbook; report: Report; native?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const byId = useMemo(() => {
    const map = new Map<string, Row>();
    for (const s of report.sales || []) map.set(String(s.id), s);
    return map;
  }, [report]);
  return (
    <>
      <div className="native-report-group">
        {workbook.sales.channelTotals.map((c) => (
          <div key={c.channel} className="native-report-row"><span>{c.channel}</span><b>{money(c.revenue_cents)}</b></div>
        ))}
        <div className="native-report-row strong"><span>Total sales</span><b>{money(workbook.sales.totals.revenue)}</b></div>
        <div className="native-report-row strong"><span>Profit</span><b className="plus">{money(workbook.sales.totals.profit)}</b></div>
      </div>
      {native && <>
        <p className="native-report-section">ITEMS SOLD</p>
        <p className="native-report-footnote">Tap a row for every column.</p>
      </>}
      {workbook.sales.rows.map((row) => (
        <SaleRow key={row.sale_id || row.sku + row.date} row={row} raw={byId.get(row.sale_id)} report={report} money={money} open={open} setOpen={setOpen} native={native} />
      ))}
    </>
  );
}

function SaleRow({ row, raw, report, money, open, setOpen, native }: { row: SalesLine; raw?: Row; report: Report; money: (c: number) => string; open: string | null; setOpen: (v: string | null) => void; native?: boolean }) {
  const key = row.sale_id || `${row.sku}:${row.order_no}`;
  const expanded = open === key;
  const whys = raw ? saleWhyLines(raw, report) : [];
  const extraShip = row.label_cost_cents > 0 && row.buyer_shipping_cents > row.label_cost_cents;
  const lessShip = row.label_cost_cents > 0 && row.label_cost_cents > row.buyer_shipping_cents;
  if (!native) {
    return null;
  }
  return (
    <div className="books-sale-card native-report-form">
      <button type="button" className="books-sale-head" onClick={() => setOpen(expanded ? null : key)}>
        <SaleTitle label={row.title} sub={`${row.sku} · ${row.channel} · ${shortDate(row.date)}`} />
        <b className={row.profit_cents == null ? '' : 'plus'}>{row.profit_cents == null ? '—' : money(row.profit_cents)}</b>
      </button>
      <p className="books-sale-line">Sold {money(row.price_cents)}</p>
      <p className="books-sale-line muted">
        Fees {money(row.marketplace_fees_cents + row.card_fees_cents)}
        {lessShip ? ` · We paid ${money(row.label_cost_cents - row.buyer_shipping_cents)} extra ship` : extraShip ? ' · Buyer paid ship' : row.label_cost_cents ? ` · Label ${money(row.label_cost_cents)}` : ''}
        {' · '}Cost {row.cost_cents == null ? <em className="fix">missing</em> : money(row.cost_cents)}
      </p>
      {whys.map((w) => <p key={w.text} className={`books-why books-why-${w.tone}`}>{w.tag ? `${w.tag} · ` : ''}{w.text}</p>)}
      {expanded && (
        <dl className="books-sale-detail">
          {[['Order', row.order_no], ['Qty', row.qty], ['Tax', money(row.tax_cents)], ['Buyer shipping', money(row.buyer_shipping_cents)], ['Label cost', money(row.label_cost_cents)], ['Commission', row.commission_cents == null ? '—' : money(row.commission_cents)]].map(([k, v]) => (
            <div key={String(k)}><dt>{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      )}
    </div>
  );
}

function SaleTitle({ label, sub }: { label: string; sub: string }) {
  return <div><strong>{label}</strong><small>{sub}</small></div>;
}

function ExpensesBody({ money, workbook, native }: { money: (c: number) => string; workbook: BooksWorkbook; native?: boolean }) {
  const [openPromo, setOpenPromo] = useState<string | null>(null);
  const groups = groupExpensesByCategory(workbook.expenses.rows);
  const head = native ? (
    <div className="books-expense-hero native-report-form">
      <div><small>Total out</small><strong className="warning-text">{money(workbook.expenses.total_cents)}</strong></div>
      <div><small>To reimburse</small><strong>{money(workbook.expenses.reimburse_cents)}</strong></div>
    </div>
  ) : (
    <p className="books-expense-grand">Total out {money(workbook.expenses.total_cents)} · To reimburse {money(workbook.expenses.reimburse_cents)}</p>
  );

  const rowList = (r: ExpenseDisplayLine) => {
    if (r.excludeFromTotals && r.duplicateFlag) return null;
    const isRollup = Boolean(r.children?.length);
    const expanded = openPromo === r.id;
  const sub = (
      <small>
        {isRollup ? r.meta : shortDate(r.date)}
        {r.needs_reimbursement && !isRollup && <em className="books-reimb-tag">REIMBURSE</em>}
        {!isRollup && r.sourceDisplay ? ` · ${r.sourceDisplay}` : ''}
        {!isRollup && r.sku_or_order && !r.title.includes(r.sku_or_order) ? ` · ${r.sku_or_order}` : ''}
      </small>
    );
    if (isRollup && native) {
      return (
        <button key={r.id} type="button" className="native-report-row books-expense-row" onClick={() => setOpenPromo(expanded ? null : r.id)}>
          <span><strong>{r.title}</strong>{sub}</span>
          <b>{money(r.amount_cents)}<i className="native-chevron">{expanded ? '⌄' : '›'}</i></b>
        </button>
      );
    }
    return (
      <div key={r.id} className={`native-report-row books-expense-row${r.duplicateFlag ? ' dimmed' : ''}`}>
        <span><strong>{r.title}</strong>{sub}</span>
        <b>{r.excludeFromTotals ? '—' : money(r.amount_cents)}</b>
      </div>
    );
  };

  const body = groups.map(([cat, rows]) => (
    <div key={cat}>
      <div className="native-report-section books-cat-head">
        <span>{cat.toUpperCase()}</span>
        <b className="cat-total">{money(rows.filter((r) => !r.excludeFromTotals).reduce((n, r) => n + r.amount_cents, 0))}</b>
      </div>
      <div className="native-report-group">
        {rows.filter((r) => !(r.excludeFromTotals && r.duplicateFlag)).map((r) => (
          <Fragment key={r.id}>
            {rowList(r)}
            {r.children?.length && openPromo === r.id ? r.children.filter((c) => !(c.excludeFromTotals && c.duplicateFlag)).map((c) => rowList(c)) : null}
          </Fragment>
        ))}
      </div>
    </div>
  ));

  const foot = <p className="native-report-footnote">Labels bought through eBay, TikTok or Amazon live in Sales, not here.</p>;

  if (!native) {
    return (
      <>
        {head}
        {groups.map(([cat, rows]) => (
          <section key={cat} className="books-spreadsheet">
            <h2 className="books-kicker">{cat}</h2>
            <div className="books-table-wrap">
              <table className="books-table">
                <thead><tr><th>Date</th><th>Description</th><th>SKU / order</th><th>Source</th><th>Reimb?</th><th>Amount</th></tr></thead>
                <tbody>
                  {rows.filter((r) => !(r.excludeFromTotals && r.duplicateFlag)).map((r) => (
                    <tr key={r.id} className={r.duplicateFlag ? 'dimmed' : ''}>
                      <td>{shortDate(r.date)}</td><td>{r.title}{r.meta ? ` · ${r.meta}` : ''}</td><td>{r.sku_or_order}</td><td>{r.sourceDisplay}</td><td>{r.needs_reimbursement ? 'Yes' : ''}</td><td>{r.excludeFromTotals ? '—' : money(r.amount_cents)}</td>
                    </tr>
                  ))}
                  <tr className="books-total-row"><td colSpan={5}>{cat} subtotal</td><td>{money(rows.filter((x) => !x.excludeFromTotals).reduce((n, x) => n + x.amount_cents, 0))}</td></tr>
                </tbody>
              </table>
            </div>
          </section>
        ))}
        {foot}
      </>
    );
  }
  return <>{head}{body}{foot}</>;
}

function PayoutsBody({ money, workbook, periodWord = 'month' }: { money: (c: number) => string; workbook: BooksWorkbook; native?: boolean; periodWord?: string }) {
  const [openStore, setOpenStore] = useState<string | null>(null);
  const p = workbook.payouts;
  const section = (title: string, total: number | null, children: ReactNode) => (
    <div className="books-payout-section">
      <div className="native-report-section books-cat-head"><span>{title}</span>{total != null && <b className="cat-total">{money(total)}</b>}</div>
      <div className="native-report-group">{children}</div>
    </div>
  );
  return (
    <>
      {section('STORE BALANCES (MONEY TAB)', p.bankPaidTotal_cents, (
        <>
          <p className="native-report-footnote">From Safe · bank payouts and balances for this {periodWord}. All-time owed is the payout ledger, counted once.</p>
          {p.stores.map((s) => (
            <div key={s.account}>
              <button type="button" className="native-report-row books-store-row" onClick={() => setOpenStore(openStore === s.account ? null : s.account)}>
                <span>
                  <strong>{s.label}</strong>
                  <small>
                    Start {s.start_balance_cents == null ? '—' : money(s.start_balance_cents)}{s.start_balance_estimated ? ' (est.)' : ''}
                    {' · In '}{money(s.money_in_cents)}
                    {' · To bank '}{money(s.paid_to_bank_cents)}
                    {' · End '}{s.end_balance_cents == null ? '—' : money(s.end_balance_cents)}{s.end_balance_estimated ? ' (est.)' : ''}
                  </small>
                </span>
                <i className="native-chevron">{openStore === s.account ? '⌄' : '›'}</i>
              </button>
              {openStore === s.account && s.transfers.map((w) => (
                <div key={w.id} className="native-report-row indent">
                  <span><small>{shortDate(w.at)} · {w.reason}{w.note ? ` · ${w.note}` : ''}</small></span>
                  <b className={w.direction === 'out' ? 'minus' : 'plus'}>{money(w.amount_cents)}</b>
                </div>
              ))}
            </div>
          ))}
        </>
      ))}
      {section('COMMISSIONS', p.commission_total_cents, (
        <>
          {p.commissions.map((c) => (
            <div key={c.person} className="native-report-row">
              <span>
                <strong>{c.person}</strong>
                {c.role === 'owner' ? (
                  <small>Owner share this month</small>
                ) : (
                  <small>
                    Earned {money(c.earned_cents)}
                    {c.paid_cents ? ` · Paid ${money(c.paid_cents)}` : ''}
                    {' · All-time owed '}{money(c.owed_all_time_cents)}
                  </small>
                )}
              </span>
              <b className={c.role === 'owner' ? 'positive' : ''}>{money(c.role === 'owner' ? c.earned_cents : c.earned_cents)}</b>
            </div>
          ))}
          <div className="native-report-row pending">
            <span>Still owed (all-time, Paul + Jacob)</span>
            <b className="warning-text">{money(p.stillOwed_all_time_cents)}</b>
          </div>
        </>
      ))}
      <div className="books-owner-card native-report-form">
        <p className="native-report-section">OWNER</p>
        <div className="books-summary-stack owner-stack">
          <div className="books-summary-line"><span>Profit</span><b>{money(p.owner.profit)}</b></div>
          <div className="books-summary-line"><span>− Commissions</span><b>{money(p.owner.commission)}</b></div>
          <div className="books-summary-line"><span>− Other expenses</span><b>{money(p.owner.otherExpenses)}</b></div>
          <div className="books-summary-line profit-line"><span>= Owner keeps</span><b className="positive">{money(p.owner.ownerKeeps)}</b></div>
        </div>
        <p className="native-report-footnote">Other expenses = Expenses page minus anything already counted in profit.</p>
      </div>
    </>
  );
}

function InventoryBody({ money, inventory, manifested = 0, native, periodWord = 'month' }: { money: (c: number) => string; inventory: InventorySummary; manifested?: number; native?: boolean; periodWord?: string }) {
  const o = inventory.owner;
  const v = o?.value;
  const rows = [
    [`Start of ${periodWord}`, inventory.start_unit_count, ''],
    ['Received', inventory.received_units, '+'],
    ['Returned to stock', inventory.return_to_stock_units ?? 0, '+'],
    ['Sold', inventory.sold_units, '-'],
    ['Given away', inventory.giveaway_units, '-'],
    ['Sent as replacements', inventory.replacement_units, '-'],
    ['Moved to Defective', inventory.defective_units, '-'],
    [`End of ${periodWord}`, inventory.end_unit_count, ''],
  ] as const;
  const move = o?.movement || {};
  return (
    <>
      {v && (
        <div className={native ? 'native-report-group' : 'books-table-wrap'}>
          <p className="native-report-section">ON THE SHELF</p>
          <div className="native-report-row"><span>Units now</span><b>{v.end_units ?? inventory.end_unit_count}</b></div>
          <div className="native-report-row"><span>Cost value</span><b>{money(Number(v.end_cost_cents || 0))}</b></div>
          <div className="native-report-row"><span>Floor price value</span><b>{money(Number(v.end_floor_cents || 0))}</b></div>
          <div className="native-report-row"><span>Start units{v.start_source === 'snapshot' ? '' : ' (estimated)'}</span><b>{v.start_units ?? inventory.start_unit_count}</b></div>
          <div className="native-report-row"><span>Start cost{v.start_source === 'snapshot' ? '' : ' (estimated)'}</span><b>{money(Number(v.start_cost_cents || 0))}</b></div>
          {v.start_note && <p className="books-proof-audit">{v.start_note}</p>}
          {o?.listed_once && <div className="native-report-row"><span>Listed somewhere (counted once)</span><b>{o.listed_once.units} · {money(Number(o.listed_once.cost_cents || 0))}</b></div>}
          <div className="native-report-row"><span>Defective items on hand</span><b>{o?.defective_shelf?.units ?? 0} · {money(Number(o?.defective_shelf?.cost_cents || 0))}</b></div>
        </div>
      )}
      {(o?.categories || []).length > 0 && (
        <>
          <p className="native-report-section">BY CATEGORY</p>
          <div className="native-report-group">
            {o!.categories!.map((c) => (
              <div key={c.category} className="native-report-row">
                <span><strong>{c.category}</strong><small>{c.units} on hand · sold {c.sold_units} · {c.sell_through}% sell-through</small></span>
                <b>{money(c.cost_cents)}</b>
              </div>
            ))}
          </div>
        </>
      )}
      {liveListedChannels(o?.listed || []).length > 0 && (
        <>
          <p className="native-report-section">LISTED BY CHANNEL</p>
          <div className="native-report-group">
            {liveListedChannels(o!.listed || []).map((c) => (
              <div key={c.channel} className="native-report-row"><span>{c.channel}</span><b>{c.units} · {money(c.cost_cents)}</b></div>
            ))}
          </div>
        </>
      )}
      {(o?.unlisted || []).length > 0 && (
        <>
          <p className="native-report-section">NOT LISTED</p>
          <div className="native-report-group">
            {(() => {
              const lines = notListedLines(o!.unlisted || [], o!.defective_shelf);
              return <>
                <div className="native-report-row"><span>Total</span><b>{lines.units} · {money(lines.cost_cents)}</b></div>
                <div className="native-report-row"><span>Defective</span><b>{lines.defective_units} · {money(lines.defective_cost_cents)}</b></div>
              </>;
            })()}
          </div>
        </>
      )}
      {(o?.aging || []).length > 0 && (
        <>
          <p className="native-report-section">AGING</p>
          <div className="native-report-group">
            {o!.aging!.map((c) => (
              <div key={c.bucket} className="native-report-row"><span>{c.bucket}</span><b>{c.units} · {money(c.cost_cents)}</b></div>
            ))}
          </div>
        </>
      )}
      {o?.movement && (
        <>
          <p className="native-report-section">THIS MONTH AT COST</p>
          <div className="native-report-group">
            {[
              ['Received', move.received_units, move.received_cost_cents],
              ['Sold', move.sold_units, move.sold_cost_cents],
              ['Returned to stock', move.return_to_stock_units, move.return_to_stock_cost_cents],
              ['Given away', move.giveaway_units, move.giveaway_cost_cents],
              ['Replacements', move.replacement_units, move.replacement_cost_cents],
              ['Moved to Defective', move.defective_units, move.defective_cost_cents],
            ].map(([label, units, cents]) => (
              <div key={String(label)} className="native-report-row"><span>{label}</span><b>{units} · {money(Number(cents || 0))}</b></div>
            ))}
          </div>
        </>
      )}
      {(o?.slowest || []).length > 0 && (
        <>
          <p className="native-report-section">SLOWEST</p>
          <div className="native-report-group">
            {o!.slowest!.map((s) => (
              <div key={s.sku} className="native-report-row">
                <span><strong>{s.title}</strong><small>SKU {s.sku} · {s.days == null ? 'no received date' : `${s.days} days`} · {s.listed || 'not listed'}</small></span>
                <b>{money(s.cost_cents)}</b>
              </div>
            ))}
          </div>
        </>
      )}
      <div className={`${native ? 'native-report-group' : 'books-table-wrap books-inventory-flow'}`}>
        {rows.flatMap(([label, value, sign]) => {
          const row = native
            ? <div key={label} className={`native-report-row${String(label).startsWith('End of') ? ' strong' : ''}`}><span>{label}</span><b className={sign === '+' ? 'plus' : sign === '-' ? 'minus' : ''}>{sign ? `${sign}${value}` : value}</b></div>
            : <div key={label} className="books-flow-row"><span>{label}</span><b>{value}</b></div>;
          if (label !== 'Received') return [row];
          const manifestedRow = native
            ? <div key="manifested" className="native-report-row"><span>Manifested</span><b>{manifested}</b></div>
            : <div key="manifested" className="books-flow-row"><span>Manifested</span><b>{manifested}</b></div>;
          return [row, manifestedRow];
        })}
      </div>
      <DetailBlock title="GIVEN AWAY" items={(inventory.giveaways || []).map((g) => ({ t: String(g.title), s: `${shortDate(String(g.date))} · SKU ${g.sku} · ${g.given_to}`, r: money(Number(g.cost_cents || 0)) }))} />
      <DetailBlock title="REPLACEMENTS" items={(inventory.replacements || []).map((r) => ({ t: String(r.title), s: `Sale #${r.original_sale_id} · SKU ${r.sku}`, r: r.bad_unit_status === 'returned' ? 'Bad unit back' : String(r.bad_unit_status || '—') }))} />
      <DetailBlock title="RETURNS" items={(o?.returns?.length ? o.returns : inventory.returns || []).map((r) => ({ t: String(r.title || r.sku), s: `${r.channel} · SKU ${r.sku} · Refund ${money(Number(r.refund_cents || 0))}`, r: String(r.status || '') }))} />
    </>
  );
}

function DetailBlock({ title, items }: { title: string; items: { t: string; s: string; r: string }[] }) {
  if (!items.length) return <><p className="native-report-section">{title}</p><p className="empty">None this month</p></>;
  return (
    <>
      <p className="native-report-section">{title}</p>
      <div className="native-report-group">
        {items.map((it) => (
          <div key={it.t + it.s} className="native-report-row">
            <span><strong>{it.t}</strong><small>{it.s}</small></span>
            <b>{it.r}</b>
          </div>
        ))}
      </div>
    </>
  );
}

function ReceivedBody({ money, items, manifested = 0, native }: { money: (c: number) => string; items: ReceivedItem[]; manifested?: number; native?: boolean }) {
  const stats = receivedMonthStats(items);
  const groups = groupReceivedByDay(items);
  return (
    <>
      <div className="books-received-stats">
        <div><small>Units</small><b>{stats.units}</b></div>
        <div><small>SKUs</small><b>{stats.skus}</b></div>
        <div><small>Total cost</small><b>{money(stats.cost_cents)}</b></div>
      </div>
      <p className="books-manifested-total">Manifested <b>{manifested}</b></p>
      {groups.map(([day, rows]) => (
        <div key={day}>
          <p className="native-report-section">{dayHeader(day)}</p>
          <div className={native ? 'native-report-group' : 'books-table-wrap'}>
            {rows.map((r) => native ? (
              <div key={String(r.sku)} className="native-report-row books-received-row">
                <span>
                  <strong>{String(r.title)}</strong>
                  <small>SKU {String(r.sku)} · {String(r.category || '—')} · {String(r.condition || '—')}{r.cost_cents ? ` · Cost ${money(Number(r.cost_cents))}` : ' · Cost —'}{r.ask_cents ? ` · Floor ${money(Number(r.ask_cents))}` : ''}</small>
                  <small className={!r.cost_cents ? 'fix' : ''}>{String(r.listing_status || r.unit_state || 'In stock')}{r.receiver_name ? ` · by ${r.receiver_name}` : ''}</small>
                </span>
                <b>×{Number(r.qty_on_hand || 1)}</b>
              </div>
            ) : (
              <table key={String(r.sku)} className="books-table"><tbody><tr>
                <td>{shortDate(String(r.received_at || ''))}</td><td>{String(r.sku)}</td><td>{String(r.title)}</td><td>{Number(r.qty_on_hand || 1)}</td>
                <td>{r.cost_cents ? money(Number(r.cost_cents)) : '—'}</td><td>{String(r.listing_status || '')}</td>
              </tr></tbody></table>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function channelLabel(name: string) {
  const n = name.toLowerCase().replace(/[_-]+/g, ' ');
  if (n === 'ebay') return 'eBay';
  if (n === 'depop') return 'Depop';
  if (n === 'mercari') return 'Mercari';
  if (n === 'amazon') return 'Amazon';
  if (n === 'tiktok') return 'TikTok';
  if (n === 'square' || n === 'website' || n === 'register' || n === 'in store' || n === 'instore') return 'In-store';
  return name;
}

function SalesTable({ money, workbook, totals, focusIds }: { money: (c: number) => string; workbook: BooksWorkbook; totals: BookTotals; focusIds?: string[] }) {
  useEffect(() => {
    const id = focusIds?.[0];
    if (!id) return;
    document.getElementById(`books-sale-${id}`)?.scrollIntoView({ block: 'center' });
  }, [focusIds]);
  const order = ['ebay', 'in-store', 'depop', 'mercari', 'amazon', 'tiktok'];
  const accounts = [...workbook.sales.channelTotals].sort((a, b) => {
    const ai = order.indexOf(channelLabel(a.channel).toLowerCase());
    const bi = order.indexOf(channelLabel(b.channel).toLowerCase());
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  return (
    <>
      <p className="books-account-line">
        {accounts.map((c) => <span key={c.channel}><b>{channelLabel(c.channel)}</b> {money(c.revenue_cents)}</span>)}
      </p>
      <div className="books-table-wrap">
        <table className="books-table books-sales-table">
          <thead>
            <tr>
              <th>Date</th><th>Item</th><th>Channel</th><th className="num">Sale</th><th className="num">Fees</th>
              <th className="num">Label</th><th className="num">Cost</th><th className="num">Profit</th><th className="num">Payout</th>
            </tr>
          </thead>
          <tbody>
            {workbook.sales.rows.map((r) => (
              <tr key={r.sale_id + r.sku} id={`books-sale-${r.sale_id}`} className={focusIds?.includes(r.sale_id) ? 'books-sale-focus' : undefined}>
                <td>{shortDate(r.date)}</td>
                <td className="books-item"><strong>{r.title}</strong><small>SKU {r.sku}</small></td>
                <td><span className="books-channel-chip">{channelLabel(r.channel)}</span></td>
                <td className="num">{money(r.price_cents)}</td>
                <td className="num">{money(r.marketplace_fees_cents + r.card_fees_cents)}</td>
                <td className="num">{r.label_cost_cents ? money(r.label_cost_cents) : '—'}</td>
                <td className={r.cost_cents == null ? 'num fix' : 'num'}>{r.cost_cents == null ? 'missing' : money(r.cost_cents)}</td>
                <td className="num">{r.profit_cents == null ? '—' : money(r.profit_cents)}</td>
                <td className="num">{r.commission_cents == null ? '—' : money(r.commission_cents)}</td>
              </tr>
            ))}
            <tr className="books-total-row">
              <td colSpan={3}>Totals</td>
              <td className="num">{money(totals.revenue)}</td>
              <td className="num">{money(totals.feesAndLabels)}</td>
              <td className="num">{money(totals.labelCostsOnSales)}</td>
              <td className="num">{money(totals.cost)}</td>
              <td className="num">{money(totals.profit)}</td>
              <td className="num">{money(totals.commission)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="hint">Export has Excel, PDF, Print and Download all periods. Tax and buyer shipping stay in Excel and PDF.</p>
    </>
  );
}

function ExpensesTable({ money, workbook }: { money: (c: number) => string; workbook: BooksWorkbook }) {
  return <ExpensesBody money={money} workbook={workbook} native={false} />;
}

// noop helper to avoid fragment lint noise in expense desktop layout

function shortDate(iso: string) {
  if (!iso) return '—';
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function dayHeader(iso: string) {
  return shortDate(iso).toUpperCase();
}
