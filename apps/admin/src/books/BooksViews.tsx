import { Fragment, useMemo, useState, type ReactNode } from 'react';
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
import { BooksIconExpenses, BooksIconInventory, BooksIconPayouts, BooksIconReceived, BooksIconSales, BooksIconTax } from './reportIcons';

export type Sheet = 'hub' | 'sales' | 'expenses' | 'payouts' | 'inventory' | 'received' | 'tax';

const REPORT_ROWS: { id: Sheet; title: string; sub: string; hue: string; Icon: (p: { color: string }) => ReactNode }[] = [
  { id: 'sales', title: 'Sales', sub: 'Each item sold, by SKU', hue: '#0a84ff', Icon: BooksIconSales },
  { id: 'expenses', title: 'Expenses', sub: "Money out that isn't in a sale", hue: '#ff9f0a', Icon: BooksIconExpenses },
  { id: 'payouts', title: 'Payouts', sub: "Store payouts, commissions, owner's take", hue: '#30d158', Icon: BooksIconPayouts },
  { id: 'inventory', title: 'Inventory', sub: 'Stock, giveaways, replacements, returns', hue: '#5ac8fa', Icon: BooksIconInventory },
  { id: 'received', title: 'Items received', sub: 'Everything inventoried this month', hue: '#bf5af2', Icon: BooksIconReceived },
  { id: 'tax', title: 'Sales tax return', sub: 'CDTFA-401-A for this filing period', hue: '#ffffff', Icon: BooksIconTax },
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
};

export function BooksViews(props: ViewProps) {
  return props.native ? <BooksNative {...props} /> : <BooksDesktop {...props} />;
}

function BooksNative(p: ViewProps) {
  if (p.sheet !== 'hub') {
    return (
      <div className="native-report-body books-sheet">
        {p.sheet !== 'tax' && <button type="button" className="native-report-action" aria-label="Download" disabled={!p.exportFiles} onClick={p.onExcel}>↓</button>}
        <p className="books-sheet-period">{monthLabel(p.period.period_start)}</p>
        {p.sheet === 'sales' && <SalesBody money={p.money} workbook={p.workbook} report={p.report} native />}
        {p.sheet === 'expenses' && <ExpensesBody money={p.money} workbook={p.workbook} native onDuplicateDecision={p.onDuplicateDecision} />}
        {p.sheet === 'payouts' && <PayoutsBody money={p.money} workbook={p.workbook} native />}
        {p.sheet === 'inventory' && <InventoryBody money={p.money} inventory={p.inventory} native />}
        {p.sheet === 'received' && <ReceivedBody money={p.money} items={p.workbook.received} native />}
        {p.sheet === 'tax' && <CdtfaReturn client={p.client} money={p.money} monthStart={p.period.period_start} />}
      </div>
    );
  }
  const ui = periodUiStatus(p.period);
  return (
    <div className="native-report-body books-native-hub">
      <button type="button" className="books-month-field" aria-haspopup="listbox" aria-expanded={p.pickerOpen} onClick={() => p.setPickerOpen(true)}>
        <small>MONTH</small>
        <span>{periodPickerLabel(p.period)}</span>
        <i className="native-chevron books-month-chevron" aria-hidden>›</i>
      </button>
      <SummaryCard money={p.money} totals={p.totals} native absorbFees={p.absorbFees} onlineChannels={p.onlineChannels} />
      <BooksProofBar money={p.money} workbook={p.workbook} />
      <BooksExportTieBar workbook={p.workbook} />
      <p className="native-report-section">REPORTS</p>
      <div className="native-report-group">
        {REPORT_ROWS.map((r) => (
          <button key={r.id} type="button" className="native-report-row books-report-link" onClick={() => p.setSheet(r.id)}>
            <span className="books-report-icon" aria-hidden><r.Icon color="#ffffff" /></span>
            <span>{r.title}<small>{r.sub}</small></span>
            <i className="native-chevron">›</i>
          </button>
        ))}
      </div>
      <div className="books-native-export-row">
        <button type="button" className="books-native-export" disabled={!p.exportFiles || p.exportsPreparing} onClick={p.onExcel}>Download Excel</button>
        <button type="button" className="books-native-export" disabled={!p.exportFiles || p.exportsPreparing} onClick={p.onPdf}>Print / PDF</button>
      </div>
      <BooksLock native client={p.client} money={p.money} period={p.period} report={p.report} inventory={p.inventory} received={p.received} workbook={p.workbook} uiStatus={ui} busy={p.busy} setBusy={p.setBusy} onError={p.onError} onReload={p.onReload} lockedStaleMath={p.lockedStaleMath} />
      {p.pickerOpen && <MonthPickerSheet {...p} />}
    </div>
  );
}

function BooksDesktop(p: ViewProps) {
  const ui = periodUiStatus(p.period);
  const tab = p.desktopTab === 'hub' ? 'sales' : p.desktopTab;
  return (
    <div className="books-desktop">
      <div className="books-desktop-toolbar">
        <label className="books-month-picker">
          Month
          <select value={p.periodId} onChange={(e) => p.setPeriodId(e.target.value)}>
            {p.periods.map((m) => <option key={m.id} value={m.id}>{periodPickerLabel(m)}</option>)}
          </select>
        </label>
        <span className={`books-status-pill books-status-${ui}`}>{periodStatusLabel(ui)}</span>
        <div className="books-export-actions">
          <button type="button" className="books-download" disabled={!p.exportFiles || p.exportsPreparing} onClick={p.onExcel}>Download Excel</button>
          <button type="button" className="books-download secondary" disabled={!p.exportFiles || p.exportsPreparing} onClick={p.onPdf}>PDF</button>
          <button type="button" className="books-download secondary" disabled={!p.workbook} onClick={p.onPrint}>Print</button>
        </div>
      </div>
      <SummaryCard money={p.money} totals={p.totals} absorbFees={p.absorbFees} onlineChannels={p.onlineChannels} />
      <BooksProofBar money={p.money} workbook={p.workbook} />
      <BooksExportTieBar workbook={p.workbook} />
      <nav className="books-desktop-tabs" aria-label="Books reports">
        {REPORT_ROWS.map((t) => (
          <button key={t.id} type="button" className={tab === t.id ? 'active' : ''} onClick={() => p.setDesktopTab(t.id)}>{t.title}</button>
        ))}
      </nav>
      <div className="books-desktop-panel">
        {tab === 'sales' && <SalesTable money={p.money} workbook={p.workbook} totals={p.totals} />}
        {tab === 'expenses' && <ExpensesTable money={p.money} workbook={p.workbook} />}
        {tab === 'payouts' && <PayoutsBody money={p.money} workbook={p.workbook} />}
        {tab === 'inventory' && <InventoryBody money={p.money} inventory={p.inventory} />}
        {tab === 'received' && <ReceivedBody money={p.money} items={p.workbook.received} />}
        {tab === 'tax' && <CdtfaReturn client={p.client} money={p.money} monthStart={p.period.period_start} />}
      </div>
      <BooksLock client={p.client} money={p.money} period={p.period} report={p.report} inventory={p.inventory} received={p.received} workbook={p.workbook} uiStatus={ui} busy={p.busy} setBusy={p.setBusy} onError={p.onError} onReload={p.onReload} lockedStaleMath={p.lockedStaleMath} />
      <div className="books-print-sheets" aria-hidden>
        <section><h2>Sales</h2><SalesTable money={p.money} workbook={p.workbook} totals={p.totals} /></section>
        <section><h2>Expenses</h2><ExpensesTable money={p.money} workbook={p.workbook} /></section>
        <section><h2>Payouts</h2><PayoutsBody money={p.money} workbook={p.workbook} /></section>
        <section><h2>Inventory</h2><InventoryBody money={p.money} inventory={p.inventory} /></section>
        <section><h2>Items received</h2><ReceivedBody money={p.money} items={p.workbook.received} /></section>
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
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const years = [...new Set(p.periods.map((m) => m.period_start.slice(0, 4)))];
  return (
    <div className="books-picker-scrim" role="presentation" onClick={() => p.setPickerOpen(false)}>
      <div className="books-picker-sheet" role="dialog" aria-label="Pick a month" onClick={(e) => e.stopPropagation()}>
        <div className="books-picker-head">
          <strong>Pick a month</strong>
          <button type="button" onClick={() => p.setPickerOpen(false)}>Done</button>
        </div>
        {years.map((y) => (
          <div key={y}>
            <p className="books-picker-year">{y}</p>
            <div className="native-report-group">
              {p.periods.filter((m) => m.period_start.startsWith(y)).map((m) => {
                const st = periodUiStatus(m, today);
                const selected = m.id === p.periodId;
                return (
                  <button key={m.id} type="button" className={`native-report-row books-picker-row${selected ? ' selected' : ''}`} onClick={() => { p.setPeriodId(m.id); p.setPickerOpen(false); }}>
                    <span>{periodPickerLabel(m)}</span>
                    <b className={`books-picker-status books-picker-${st}`}>{selected ? '✓ ' : ''}{periodStatusLabel(st)}</b>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <p className="native-report-footnote">Only months with sales or inventory show up here.</p>
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

function ExpensesBody({ money, workbook, native, onDuplicateDecision }: { money: (c: number) => string; workbook: BooksWorkbook; native?: boolean; onDuplicateDecision?: (lineId: string, decision: 'keep' | 'remove') => void }) {
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
        {rows.map((r) => (
          <Fragment key={r.id}>
            {rowList(r)}
            {r.children?.length && openPromo === r.id ? r.children.map((c) => rowList(c)) : null}
          </Fragment>
        ))}
      </div>
    </div>
  ));

  const dupes = workbook.expenses.duplicates.filter((d) => d.pair).map((d) => {
    const a = d.pair!.primary;
    const b = d.pair!.duplicate;
    return (
      <div key={d.lineIds.join('-')} className="books-dup-card">
        <p className="books-dup-title">Possible duplicate</p>
        <p>{a.title} · {shortDate(a.date)} · {money(a.amount_cents)}</p>
        <p>{b.title} · {shortDate(b.date)} · {money(b.amount_cents)}</p>
        <div className="books-dup-actions">
          <button type="button" onClick={() => onDuplicateDecision?.(b.id, 'keep')}>Keep both</button>
          <button type="button" onClick={() => onDuplicateDecision?.(b.id, 'remove')}>Remove duplicate</button>
        </div>
      </div>
    );
  });

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
                  {rows.map((r) => (
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
        {dupes}
        {foot}
      </>
    );
  }
  return <>{head}{body}{dupes}{foot}</>;
}

function PayoutsBody({ money, workbook, native }: { money: (c: number) => string; workbook: BooksWorkbook; native?: boolean }) {
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
          <p className="native-report-footnote">From Safe · bank payouts and balances for this month.</p>
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

function InventoryBody({ money, inventory, native }: { money: (c: number) => string; inventory: InventorySummary; native?: boolean }) {
  const o = inventory.owner;
  const v = o?.value;
  const rows = [
    ['Start of month', inventory.start_unit_count, ''],
    ['Received', inventory.received_units, '+'],
    ['Returned to stock', inventory.return_to_stock_units ?? 0, '+'],
    ['Sold', inventory.sold_units, '-'],
    ['Given away', inventory.giveaway_units, '-'],
    ['Sent as replacements', inventory.replacement_units, '-'],
    ['Moved to Defective', inventory.defective_units, '-'],
    ['End of month', inventory.end_unit_count, ''],
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
        {rows.map(([label, value, sign]) => (
          native
            ? <div key={label} className={`native-report-row${label === 'End of month' ? ' strong' : ''}`}><span>{label}</span><b className={sign === '+' ? 'plus' : sign === '-' ? 'minus' : ''}>{sign ? `${sign}${value}` : value}</b></div>
            : <div key={label} className="books-flow-row"><span>{label}</span><b>{value}</b></div>
        ))}
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

function ReceivedBody({ money, items, native }: { money: (c: number) => string; items: ReceivedItem[]; native?: boolean }) {
  const stats = receivedMonthStats(items);
  const groups = groupReceivedByDay(items);
  return (
    <>
      <div className="books-received-stats">
        <div><small>Units</small><b>{stats.units}</b></div>
        <div><small>SKUs</small><b>{stats.skus}</b></div>
        <div><small>Total cost</small><b>{money(stats.cost_cents)}</b></div>
      </div>
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

function SalesTable({ money, workbook, totals }: { money: (c: number) => string; workbook: BooksWorkbook; totals: BookTotals }) {
  const headers = ['Date', 'SKU', 'Item', 'Channel', 'Order', 'Sale', 'Tax', 'Fees', 'Label', 'Buyer ship', 'Cost', 'Profit', 'Payout', 'Why'];
  return (
    <>
      <p className="books-channel-line">
        {workbook.sales.channelTotals.map((c) => <span key={c.channel}>{c.channel} {money(c.revenue_cents)}</span>)}
      </p>
      <div className="books-table-wrap">
        <table className="books-table">
          <thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {workbook.sales.rows.map((r) => (
              <tr key={r.sale_id + r.sku}>
                <td>{shortDate(r.date)}</td><td>{r.sku}</td><td>{r.title}</td><td>{r.channel}</td><td>{r.order_no}</td>
                <td>{money(r.price_cents)}</td><td>{money(r.tax_cents)}</td><td>{money(r.marketplace_fees_cents + r.card_fees_cents)}</td>
                <td>{money(r.label_cost_cents)}</td><td>{money(r.buyer_shipping_cents)}</td>
                <td className={r.cost_cents == null ? 'fix' : ''}>{r.cost_cents == null ? 'missing' : money(r.cost_cents)}</td>
                <td>{r.profit_cents == null ? '—' : money(r.profit_cents)}</td>
                <td>{r.commission_cents == null ? '—' : money(r.commission_cents)}</td>
                <td className="why">{r.profit_notes}</td>
              </tr>
            ))}
            <tr className="books-total-row">
              <td colSpan={5}>Totals</td>
              <td>{money(totals.revenue)}</td><td /><td /><td>{money(totals.labelCostsOnSales)}</td><td /><td>{money(totals.cost)}</td>
              <td>{money(totals.profit)}</td><td>{money(totals.commission)}</td><td />
            </tr>
          </tbody>
        </table>
      </div>
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
