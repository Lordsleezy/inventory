import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  MONEY_FMT,
  addReportTitle,
  bandRows,
  fitWrappedRowHeights,
  fitTitleRows,
  mergeLabelRow,
  wrapDataRows,
  cleanSkuOrder,
  displayPaidBy,
  excelDate,
  formatPeriodTitle,
  moneyCell,
  setColumnWidths,
  setNormalSheetView,
  setupPrint,
  styleHeaderRow,
  freezeHeader,
} from './exportFormat';
import { verifyExportTies } from './exportChecks';
import type { BooksWorkbook, Period, ReceivedItem, SalesLine } from './types';
import { receivedSheetMetrics } from './receivedSummary';
import { profitStatement, returnSheetRows, type ProfitLine } from './profitSheet';
import { COVERAGE, commissionTie, expenseTie, giveawayOverlap, inventoryFlow, missingCostPicture, moneyReasonLabel, reportTiming } from './plainReport';

type SpanSlice = { label: string; workbook: BooksWorkbook };
type ExportOptions = { title?: string; slices?: SpanSlice[]; word?: string };

function tieWarning(wb: BooksWorkbook) {
  const issues = wb.exportTieIssues ?? verifyExportTies(wb);
  return issues.length ? issues.map((i) => i.message).join('; ') : undefined;
}

function salesColumnTotals(rows: SalesLine[]) {
  const totals = { price: 0, fees: 0, cost: 0, profit: 0, tax: 0, card: 0, label: 0, ship: 0, commission: 0 };
  for (const row of rows) {
    totals.price += row.price_cents || 0;
    totals.fees += (row.marketplace_fees_cents || 0) + (row.card_fees_cents || 0) + (row.label_cost_cents || 0);
    totals.cost += row.cost_cents ?? 0;
    totals.profit += row.profit_cents ?? 0;
    totals.tax += row.tax_cents || 0;
    totals.card += row.card_fees_cents || 0;
    totals.label += row.label_cost_cents || 0;
    totals.ship += row.buyer_shipping_cents || 0;
    totals.commission += row.commission_cents ?? 0;
  }
  return totals;
}

function salesTotalCells(totals: ReturnType<typeof salesColumnTotals>) {
  return [
    '', '', '', '',
    moneyCell(totals.price),
    moneyCell(totals.fees),
    moneyCell(totals.cost),
    moneyCell(totals.profit),
    '',
    moneyCell(totals.tax),
    moneyCell(totals.card),
    moneyCell(totals.label),
    moneyCell(totals.ship),
    moneyCell(totals.commission),
    '',
  ];
}

export async function buildBooksExcel(period: Period, wb: BooksWorkbook, label: string, options?: ExportOptions) {
  const x = new ExcelJS.Workbook();
  x.creator = 'Floor Books';
  x.subject = label;
  const periodLabel = options?.title || formatPeriodTitle(period.period_start);
  const slices = options?.slices && options.slices.length > 1 ? options.slices : null;
  const word = options?.word || 'month';
  const generated = new Date();
  const groups = slices || [{ label: '', workbook: wb }];

  writeStartSheet(x, period, wb, groups, periodLabel, generated, word);
  writeProfitSheet(x, wb, groups, periodLabel, generated);
  writeReturnsSheet(x, groups, periodLabel, generated);

  const wsS = x.addWorksheet('Sales');
  const salesHeader = [
    'Date', 'SKU', 'Item', 'Channel', 'Sale price', 'Fees, card, label', 'Item cost', 'Profit',
    'Order #', 'Sales tax', 'Card fee', 'Shipping label (we paid)', 'Buyer paid shipping', 'Commission', 'Notes',
  ];
  const salesCols = salesHeader.length;
  const salesWidths = [12, 9, 32, 12, 12, 18, 12, 12, 14, 11, 11, 16, 16, 12, 28];
  setColumnWidths(wsS, salesWidths);
  addReportTitle(wsS, 'Sales', periodLabel, generated, salesCols);
  fitTitleRows(wsS, salesCols, salesWidths);
  const hS = wsS.rowCount + 1;
  wsS.addRow(salesHeader);
  styleHeaderRow(wsS, hS, salesHeader.length);
  const dataStartS = hS + 1;
  const salesGroups = slices || [{ label: '', workbook: wb }];
  for (const group of salesGroups) {
    if (group.label) {
      const head = wsS.addRow([group.label]);
      head.font = { bold: true };
    }
    for (const r of group.workbook.sales.rows) {
    const fees = Number(r.marketplace_fees_cents || 0) + Number(r.card_fees_cents || 0) + Number(r.label_cost_cents || 0);
    wsS.addRow([
      excelDate(r.date),
      r.sku,
      r.title,
      r.channel,
      moneyCell(r.price_cents),
      moneyCell(fees),
      r.cost_cents == null ? 'Missing' : moneyCell(r.cost_cents),
      r.profit_cents == null ? 'Not calculated' : moneyCell(r.profit_cents),
      r.order_no,
      moneyCell(r.tax_cents),
      moneyCell(r.card_fees_cents),
      moneyCell(r.label_cost_cents),
      moneyCell(r.buyer_shipping_cents),
      moneyCell(r.commission_cents),
      r.profit_notes,
    ]);
    }
    if (group.label) {
      const sub = salesColumnTotals(group.workbook.sales.rows);
      const row = wsS.addRow(salesTotalCells(sub));
      mergeLabelRow(wsS, row.number, 1, 4, `${group.label} subtotal`);
      row.font = { bold: true };
      for (const c of [5, 6, 7, 8, 10, 11, 12, 13, 14]) row.getCell(c).numFmt = MONEY_FMT;
    }
  }
  const dataEndS = wsS.rowCount;
  bandRows(wsS, dataStartS, dataEndS);
  wrapDataRows(wsS, dataStartS, dataEndS, salesCols);
  fitWrappedRowHeights(wsS, hS, dataEndS, salesWidths);
  for (let r = dataStartS; r <= dataEndS; r++) {
    const row = wsS.getRow(r);
    row.getCell(1).numFmt = 'mmm d, yyyy';
    for (const c of [5, 6, 7, 8, 10, 11, 12, 13, 14]) {
      if (row.getCell(c).value != null) row.getCell(c).numFmt = MONEY_FMT;
    }
  }
  wsS.addRow([]);
  const byChannel = new Map<string, SalesLine[]>();
  for (const sale of wb.sales.rows) {
    const list = byChannel.get(sale.channel) || [];
    list.push(sale);
    byChannel.set(sale.channel, list);
  }
  for (const [channel, rows] of [...byChannel.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const row = wsS.addRow(salesTotalCells(salesColumnTotals(rows)));
    mergeLabelRow(wsS, row.number, 1, 4, `${channel} subtotal`);
    row.font = { bold: true };
    for (const c of [5, 6, 7, 8, 10, 11, 12, 13, 14]) row.getCell(c).numFmt = MONEY_FMT;
  }
  const grand = salesColumnTotals(wb.sales.rows);
  const tot = wsS.addRow(salesTotalCells(grand));
  mergeLabelRow(wsS, tot.number, 1, 4, 'Column totals');
  tot.font = { bold: true };
  tot.border = { top: { style: 'medium' } };
  for (const c of [5, 6, 7, 8, 10, 11, 12, 13, 14]) tot.getCell(c).numFmt = MONEY_FMT;
  const tie = wsS.addRow(['Sale price plus buyer paid shipping is the sales total. Fees, card, label is marketplace fees, the card fee, and the shipping label added together. Card fee and Shipping label are also in their own columns, so do not add them again. Sales tax is not part of the sale price. Item cost says Missing when no cost was recorded. $0.00 is a real zero. The cost total adds only recorded costs.']);
  mergeLabelRow(wsS, tie.number, 1, salesCols, String(tie.getCell(1).value || ''));
  tie.getCell(1).alignment = { wrapText: true, vertical: 'middle' };
  tie.height = 36;
  const audit = wb.costAudit;
  if (audit && (audit.missing.length || audit.flaggedDefaults.length)) {
    wsS.addRow([]);
    if (audit.missing.length) {
      wsS.addRow(['Sales with no unit cost (commission $0)']).font = { bold: true };
      wsS.addRow(['Date', 'SKU', 'Channel', 'Item']);
      styleHeaderRow(wsS, wsS.rowCount, 4);
      for (const m of audit.missing) {
        wsS.addRow([excelDate(m.date), m.sku, m.channel, m.title]);
      }
    }
    if (audit.flaggedDefaults.length) {
      wsS.addRow([]);
      wsS.addRow(['Sales flagged as old default cost — verify in Inventory']).font = { bold: true };
      wsS.addRow(['Date', 'SKU', 'Channel', 'Unit cost', 'Ledger cost', 'Source']);
      styleHeaderRow(wsS, wsS.rowCount, 6);
      for (const f of audit.flaggedDefaults) {
        const row = wsS.addRow([
          excelDate(f.date),
          f.sku,
          f.channel,
          moneyCell(f.unit_cost_cents ?? null),
          moneyCell(f.ledger_cost_cents ?? null),
          f.cost_source || '',
        ]);
        row.getCell(4).numFmt = MONEY_FMT;
        row.getCell(5).numFmt = MONEY_FMT;
      }
    }
  }
  fitTitleRows(wsS, salesCols, salesWidths);
  setNormalSheetView(wsS);
  wsS.autoFilter = { from: { row: hS, column: 1 }, to: { row: dataEndS, column: salesCols } };
  freezeHeader(wsS, hS, 2);
  setupPrint(wsS, hS, { repeatHeader: true, printThroughColumn: 'H' });

  const wsE = x.addWorksheet('Expenses');
  const expHeader = ['Date', 'Category', 'Description', 'Amount', 'SKU / Order #', 'Paid by', 'Reimburse?', 'Where it hits profit'];
  const expCols = expHeader.length;
  const expWidths = [12, 16, 32, 12, 14, 16, 14, 36];
  setColumnWidths(wsE, expWidths);
  addReportTitle(wsE, 'Expenses', periodLabel, generated, expCols);
  fitTitleRows(wsE, expCols, expWidths);
  const hE = wsE.rowCount + 1;
  wsE.addRow(expHeader);
  styleHeaderRow(wsE, hE, expHeader.length);
  const startE = hE + 1;
  const expenseGroups = slices || [{ label: '', workbook: wb }];
  for (const group of expenseGroups) {
    if (group.label) {
      const head = wsE.addRow([group.label]);
      head.font = { bold: true };
    }
    for (const r of group.workbook.expenses.exportRows) {
    const row = wsE.addRow([
      excelDate(r.date),
      r.category,
      r.description,
      moneyCell(r.amount_cents),
      cleanSkuOrder(r.sku_or_order),
      displayPaidBy(r.paid_by),
      r.needs_reimbursement,
      r.treatment || '',
    ]);
    row.getCell(1).numFmt = 'mmm d, yyyy';
    row.getCell(4).numFmt = MONEY_FMT;
    }
    if (group.label) {
      const row = wsE.addRow(['', '', '', moneyCell(group.workbook.expenses.total_cents)]);
      mergeLabelRow(wsE, row.number, 1, 3, `${group.label} subtotal`);
      row.font = { bold: true };
      row.getCell(4).numFmt = MONEY_FMT;
    }
  }
  const expDataEnd = wsE.rowCount;
  bandRows(wsE, startE, expDataEnd);
  wrapDataRows(wsE, hE, expDataEnd, expCols);
  fitWrappedRowHeights(wsE, hE, expDataEnd, expWidths);
  wsE.addRow([]);
  for (const c of wb.expenses.categoryTotals) {
    const row = wsE.addRow(['', '', '', moneyCell(c.amount_cents)]);
    mergeLabelRow(wsE, row.number, 1, 3, `${c.category} subtotal`);
    row.font = { bold: true };
    row.getCell(4).numFmt = MONEY_FMT;
    fitWrappedRowHeights(wsE, row.number, row.number, expWidths);
  }
  const gt = wsE.addRow(['', '', '', moneyCell(wb.expenses.total_cents)]);
  mergeLabelRow(wsE, gt.number, 1, 3, 'Grand total');
  gt.font = { bold: true };
  gt.border = { top: { style: 'medium' } };
  gt.getCell(4).numFmt = MONEY_FMT;
  const exp = expenseTie(wb);
  const give = giveawayOverlap(wb);
  const dollarsText = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  wsE.addRow([]);
  const expHead = wsE.addRow(['Expense reconciliation']);
  mergeLabelRow(wsE, expHead.number, 1, expCols, 'Expense reconciliation');
  expHead.font = { bold: true };
  const expLine = (label: string, cents: number) => {
    const row = wsE.addRow([label, '', '', moneyCell(cents)]);
    row.getCell(4).numFmt = MONEY_FMT;
  };
  expLine('Recorded on this tab', exp.recorded);
  expLine('Already in sales or returns', exp.already);
  expLine('Deducted as operating expenses', exp.operating);
  expLine('Marked to reimburse', exp.reimburse);
  const expExplain = wsE.addRow(['Recorded expenses equal the part already inside sales and returns plus the operating expenses deducted on Profits. Amounts marked to reimburse are not a separate profit deduction. Paybacks are not tracked separately.']);
  mergeLabelRow(wsE, expExplain.number, 1, expCols, String(expExplain.getCell(1).value || ''));
  expExplain.height = 32;
  if (!exp.ties) {
    const bad = wsE.addRow(['These expense totals do not add up. The difference is unresolved.']);
    mergeLabelRow(wsE, bad.number, 1, expCols, 'These expense totals do not add up. The difference is unresolved.');
  }
  if (give.both) {
    const text = `Giveaway expenses on this tab are ${dollarsText(give.expense)}. The inventory cost of items given away is ${dollarsText(give.stock)}. They are different records. Profit deducts that inventory cost on its own line. An expense is deducted again only when it is an operating expense. Review the rows before treating them as the same loss twice.`;
    const both = wsE.addRow([text]);
    mergeLabelRow(wsE, both.number, 1, expCols, text);
    both.getCell(1).alignment = { wrapText: true };
    both.height = 48;
  }
  fitTitleRows(wsE, expCols, expWidths);
  setNormalSheetView(wsE);
  wsE.autoFilter = { from: { row: hE, column: 1 }, to: { row: expDataEnd, column: expCols } };
  freezeHeader(wsE, hE, 1);
  setupPrint(wsE, hE, { repeatHeader: true });

  const wsI = x.addWorksheet('Inventory');
  const invWidths = [42, 14, 16];
  setColumnWidths(wsI, invWidths);
  addReportTitle(wsI, 'Inventory', periodLabel, generated, 3);
  const inv = wb.inventory;
  const own = inv.owner;
  const hI = wsI.rowCount + 1;
  wsI.addRow(['', 'Count', 'Amount']);
  styleHeaderRow(wsI, hI, 3);
  const total = (label: string, count: number, cents?: number | null) => {
    const row = wsI.addRow([label, count, cents == null ? null : moneyCell(cents)]);
    row.height = 18;
    row.getCell(1).alignment = { vertical: 'middle', wrapText: false };
    if (cents != null) row.getCell(3).numFmt = MONEY_FMT;
  };
  const giveCost = (inv.giveaways || []).reduce((sum, row) => sum + Number(row.cost_cents || 0), 0);
  const refunds = (inv.returns || []).reduce((sum, row) => sum + Number(row.refund_cents || 0), 0);
  total(`In stock at start of ${word}`, inv.start_unit_count, own?.value?.start_cost_cents ?? null);
  total('Received', inv.received_units, own?.movement?.received_cost_cents ?? null);
  total('Manifested', wb.manifested_units || 0);
  total('Sold', inv.sold_units, own?.movement?.sold_cost_cents ?? null);
  total('Returned to stock', inv.return_to_stock_units ?? 0, own?.movement?.return_to_stock_cost_cents ?? null);
  total('Given away', inv.giveaway_units, giveCost);
  total('Replacements', inv.replacement_units, own?.movement?.replacement_cost_cents ?? null);
  total('Moved to defective', inv.defective_units, own?.movement?.defective_cost_cents ?? null);
  total('Defective on hand', own?.defective_shelf?.units ?? 0, own?.defective_shelf?.cost_cents ?? null);
  total('Listed online', own?.listed_once?.units ?? 0, own?.listed_once?.cost_cents ?? null);
  total(`In stock at end of ${word}`, inv.end_unit_count, own?.value?.end_cost_cents ?? null);
  total('Floor price of stock on hand', own?.value?.end_units ?? inv.end_unit_count, own?.value?.end_floor_cents ?? null);
  total('Returns', inv.return_count || (inv.returns || []).length, refunds);
  const flow = inventoryFlow(wb);
  total('Movement check', flow.calculated, null);
  const flowNote = flow.ties
    ? 'Opening stock plus receipts plus returns to stock, minus sales, giveaways, replacements, and moves to defective, equals the closing count.'
    : `Opening stock plus units in, minus units out, comes to ${flow.calculated}. The closing count is ${flow.end}. That difference is unresolved.`;
  const flowRow = wsI.addRow([flowNote]);
  mergeLabelRow(wsI, flowRow.number, 1, 3, flowNote);
  flowRow.getCell(1).alignment = { wrapText: true };
  flowRow.height = 32;
  const receivedCounts = missingCostPicture(wb);
  const defs = [
    'Received on this tab is units the inventory movement recorded in this period. The Received tab counts item records inventoried in the period, which can be a different list.',
    `Manifested (${wb.manifested_units || 0}) is the item count written on manifests dated in this period. It is paperwork, not units scanned into stock.`,
    `Items inventoried: ${receivedCounts.receivedSkus} records, ${receivedCounts.receivedUnits} units. Known acquisition cost on that list: $${(receivedCounts.receivedKnownCost / 100).toFixed(2)}. Units with no cost recorded: ${receivedCounts.receivedMissing}. A cost of $0.00 is a real zero, not a missing cost.`,
    'Listed, unlisted, and defective are overlapping ways of looking at stock on hand. A unit can be listed and also counted in the closing stock. Floor price is the asking price, not what the item cost.',
    'Amounts in the Amount column are acquisition cost unless the row says floor price.',
  ];
  for (const text of defs) {
    const row = wsI.addRow([text]);
    mergeLabelRow(wsI, row.number, 1, 3, text);
    row.getCell(1).alignment = { wrapText: true };
    row.height = 36;
  }
  bandRows(wsI, hI + 1, hI + 13);
  fitTitleRows(wsI, 3, invWidths);
  setNormalSheetView(wsI);
  setupPrint(wsI, hI, { repeatHeader: true });

  const wsP = x.addWorksheet('Payouts');
  const payWidths = [32, 18, 18, 18, 18];
  setColumnWidths(wsP, payWidths);
  addReportTitle(wsP, 'Payouts', periodLabel, generated, 5);
  fitTitleRows(wsP, 5, payWidths);
  const p = wb.payouts;
  wsP.addRow(['Money paid out to bank']).font = { bold: true, size: 12 };
  const bankHeader = ['Source', 'Starting balance', 'Money in', 'Paid to bank', 'Ending balance'];
  wsP.addRow(bankHeader);
  const hP = wsP.rowCount;
  styleHeaderRow(wsP, hP, bankHeader.length);
  const bankStart = hP + 1;
  for (const s of p.stores) {
    wsP.addRow([
      s.label,
      moneyCell(s.start_balance_cents),
      moneyCell(s.money_in_cents),
      moneyCell(s.paid_to_bank_cents),
      moneyCell(s.end_balance_cents),
    ]);
  }
  const sumStart = p.stores.reduce((n, s) => n + (s.start_balance_cents || 0), 0);
  const sumEnd = p.stores.reduce((n, s) => n + (s.end_balance_cents || 0), 0);
  const sumIn = p.stores.reduce((n, s) => n + s.money_in_cents, 0);
  const sumOut = p.stores.reduce((n, s) => n + s.paid_to_bank_cents, 0);
  const bankTot = wsP.addRow([
    'Total',
    moneyCell(sumStart),
    moneyCell(sumIn),
    moneyCell(sumOut),
    moneyCell(sumEnd),
  ]);
  bankTot.font = { bold: true };
  wsP.addRow([]);
  const logHead = wsP.addRow(['Payouts and withdrawals this month']);
  mergeLabelRow(wsP, logHead.number, 1, 5, 'Payouts and withdrawals this month');
  logHead.font = { bold: true, size: 12 };
  wsP.addRow(['Date', 'Source', 'Amount', 'Reference', 'Who / why']);
  styleHeaderRow(wsP, wsP.rowCount, 5);
  const logStart = wsP.rowCount + 1;
  for (const s of p.stores) {
    for (const t of s.transfers || []) {
      const rawReason = String(t.reason || '');
      const row = wsP.addRow([
        excelDate(String(t.at || '')),
        s.label,
        moneyCell(t.amount_cents),
        moneyReasonLabel(rawReason) || String(t.note || ''),
        [rawReason, String(t.note || '')].filter(Boolean).join(' · '),
      ]);
      row.getCell(1).numFmt = 'mmm d, yyyy';
      row.getCell(3).numFmt = MONEY_FMT;
    }
  }
  const logged = p.stores.reduce((n, s) => n + (s.transfers || []).reduce((a, t) => a + t.amount_cents, 0), 0);
  const logTot = wsP.addRow(['Total paid out', '', moneyCell(logged), logged === sumOut ? 'Ties to the paid-to-bank column' : 'Does not tie to the paid-to-bank column', '']);
  logTot.font = { bold: true };
  logTot.getCell(3).numFmt = MONEY_FMT;
  if (logStart <= wsP.rowCount) fitWrappedRowHeights(wsP, logStart, wsP.rowCount, payWidths);
  for (let r = bankStart; r <= wsP.rowCount; r++) {
    for (const c of [2, 3, 4, 5]) {
      const cell = wsP.getRow(r).getCell(c);
      if (cell.value != null && cell.value !== '') cell.numFmt = MONEY_FMT;
    }
  }
  wsP.addRow([]);
  if (slices) {
    wsP.addRow(['Month subtotals']).font = { bold: true, size: 12 };
    for (const slice of slices) {
      const row = wsP.addRow([slice.label, moneyCell(slice.workbook.payouts.commission_total_cents), moneyCell(slice.workbook.sales.totals.profit), moneyCell(slice.workbook.payouts.owner.ownerKeeps)]);
      row.getCell(2).numFmt = MONEY_FMT;
      row.getCell(3).numFmt = MONEY_FMT;
      row.getCell(4).numFmt = MONEY_FMT;
    }
    wsP.addRow([]);
  }
  const payNote = wsP.addRow(['Amounts in the payout log are positive when money left the account. A recorded transfer has not been matched to a bank statement. Owner keeps is profit after commissions and operating expenses. It is not cash available to withdraw.']);
  mergeLabelRow(wsP, payNote.number, 1, 5, String(payNote.getCell(1).value || ''));
  payNote.height = 32;
  wsP.addRow(['Commissions (Paul & Jacob)']).font = { bold: true, size: 12 };
  const commExplain = wsP.addRow(['Earned is this period only. Still owed is the all-time balance, not the opening balance. Opening owed and adjustment reasons are not on this export. A voided sale is off this period, so its commission is not in earned. An open return does not change commission yet.']);
  mergeLabelRow(wsP, commExplain.number, 1, 5, String(commExplain.getCell(1).value || ''));
  commExplain.height = 36;
  wsP.addRow(['Person', 'Earned this period', 'Paid this period', 'Still owed (all time)', 'Opening owed']);
  styleHeaderRow(wsP, wsP.rowCount, 5);
  const commStart = wsP.rowCount + 1;
  for (const c of p.commissions.filter((x) => x.role === 'staff')) {
    wsP.addRow([c.person, moneyCell(c.earned_cents), moneyCell(c.paid_cents), moneyCell(c.owed_all_time_cents), 'Not available']);
  }
  for (let r = commStart; r <= wsP.rowCount; r++) {
    for (const c of [2, 3, 4]) wsP.getRow(r).getCell(c).numFmt = MONEY_FMT;
  }
  const commissionCheck = commissionTie(wb);
  const commissionText = commissionCheck.gap
    ? `Paul and Jacob earned $${(commissionCheck.named / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Profit deducts $${(commissionCheck.deducted / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. The difference is unresolved: a commission rule in the profit total is not on those two lines. It is not deducted twice.`
    : 'Paul and Jacob earned the same commission total that profit deducts.';
  const commissionRow = wsP.addRow([commissionText]);
  mergeLabelRow(wsP, commissionRow.number, 1, 5, commissionText);
  commissionRow.height = 36;
  wsP.addRow([]);
  wsP.addRow(['Owner']).font = { bold: true, size: 12 };
  const ok = p.owner;
  for (const [label, cents] of [
    ['Sales contribution', ok.profit],
    ['− Commissions', ok.commission],
    ['− Operating expenses', ok.otherExpenses],
    ['= Owner keeps', ok.ownerKeeps],
  ] as const) {
    const row = wsP.addRow([label, moneyCell(cents)]);
    if (label.startsWith('=')) row.font = { bold: true };
    row.getCell(2).numFmt = MONEY_FMT;
  }
  wrapDataRows(wsP, hP, wsP.rowCount, 5);
  fitWrappedRowHeights(wsP, hP, wsP.rowCount, payWidths);
  fitTitleRows(wsP, 5, payWidths);
  setNormalSheetView(wsP);
  setupPrint(wsP, hP);

  writeReceivedSheet(x, (slices || [{ label: '', workbook: wb }]).map((group) => ({
    label: group.label,
    items: group.workbook.received,
    manifested: group.workbook.manifested_units || 0,
  })), periodLabel, generated);

  return x.xlsx.writeBuffer();
}

function writeStartSheet(
  book: ExcelJS.Workbook,
  period: Period,
  wb: BooksWorkbook,
  groups: SpanSlice[],
  periodLabel: string,
  generated: Date,
  word: string,
) {
  const ws = book.addWorksheet('Start here');
  const widths = [38, 24, 72];
  setColumnWidths(ws, widths);
  addReportTitle(ws, 'Business summary', periodLabel, generated, 3);
  const timing = reportTiming(period, generated, word);
  const lines = profitStatement(wb);
  const find = (label: string) => lines.find((line) => line.label === label);
  const costs = missingCostPicture(wb);
  const comm = commissionTie(wb);
  const flow = inventoryFlow(wb);
  const exp = expenseTie(wb);
  const show = (cents: number | null | undefined) => (cents == null ? 'Not available' : moneyCell(cents));
  const section = (title: string) => {
    const row = ws.addRow([title]);
    mergeLabelRow(ws, row.number, 1, 3, title);
    row.font = { bold: true, size: 12 };
    row.height = 20;
  };
  const line = (label: string, value: string | number | null, note: string) => {
    const row = ws.addRow([label, value, note]);
    row.getCell(1).alignment = { vertical: 'middle', wrapText: true };
    row.getCell(3).alignment = { vertical: 'middle', wrapText: true };
    if (typeof value === 'number') row.getCell(2).numFmt = MONEY_FMT;
  };
  section('Reporting period');
  line('Status', timing.status, timing.cutoff);
  line('Period start', timing.start, 'Pacific calendar date. The day starts at midnight Pacific.');
  line('Period end', timing.end, 'Pacific calendar date. The end date is included.');
  line('Timezone', timing.timezone, 'Dates on every tab use Pacific time.');
  line('Generated', timing.generated, '');
  line('What this report includes', '', COVERAGE);
  section('Result');
  line('Net merchandise sales', show(find('Net merchandise sales')?.cents), 'Sale prices on the Sales tab, after completed refunds.');
  line('Customer-paid shipping', show(find('Customer-paid shipping')?.cents), 'Included in profit. It is not part of the sale price.');
  line('Business profit', show(find('Business profit')?.cents), 'The final profit on the Profits tab. It is not cash in the bank.');
  section('These numbers are not the same');
  line('Sales contribution', show(find('Sales contribution')?.cents), 'Profit on sales that have an item cost, before return shipping, operating expenses, and commissions.');
  line('Owner keeps', show(find('Owner keeps')?.cents), 'Sales contribution minus commissions minus operating expenses. An allocation of profit, not spendable cash.');
  line('Business profit', show(find('Business profit')?.cents), 'Owner keeps after return shipping and inventory losses that owner keeps does not subtract.');
  line('Recorded transfers to the bank', show(wb.payouts?.bankPaidTotal_cents), 'Money recorded as leaving a platform or the safe. Not matched to a bank statement.');
  section('Balances');
  const stores = wb.payouts?.stores || [];
  if (!stores.length) line('Platform and safe balances', 'Not available', 'No balance was stored for this period.');
  for (const store of stores) {
    line(
      `${store.label} balance`,
      show(store.end_balance_cents),
      store.end_balance_estimated ? 'Estimated from activity. Not a bank statement, and not spendable cash by itself.' : 'Recorded balance. Not spendable cash by itself.',
    );
  }
  line('Pending platform funds', 'Not tracked', '');
  line('Spendable cash', 'Not available', 'This report does not include a bank balance.');
  line('Commissions still owed', show(wb.payouts?.stillOwed_all_time_cents), 'All-time balance. The amount owed at the start of the period is not on this export.');
  line('Marked to reimburse', show(exp.reimburse), 'Paybacks are not tracked separately.');
  const open = find('Open returns');
  const returnsListed = Array.isArray(wb.inventory?.returns);
  line('Open returns', open ? moneyCell(open.cents) : returnsListed ? 'None' : 'Not tracked', open ? 'Listed on Returns and not deducted from profit yet.' : returnsListed ? 'The return list has no open refund amount.' : 'No return list was on this export.');
  section('Inventory and missing cost');
  line('Stock on hand at cost', show(costs.endCost), 'Acquisition cost of units on hand. Not the asking price.');
  line('Asking price of stock on hand', show(costs.endFloor), 'Floor price. Not cost, and not cash.');
  line('Sales missing a cost', `${costs.unknownSales} of ${costs.sales} sales`, `${costs.zeroCostSales} sales have a real cost of $0.00 and stay in profit. Missing costs are left out. Nothing was estimated.`);
  line('Inventoried units missing a cost', `${costs.receivedMissing} of ${costs.receivedUnits} units`, `${costs.receivedSkus} item records on the Received tab. A blank is missing. $0.00 is a real zero.`);
  line('Inventory count', flow.ties ? 'The movement ties to the closing count' : `Off by ${flow.calculated - flow.end}`, 'See the Inventory tab for the units in and out.');
  section('Profit by channel');
  if (!wb.sales.channelTotals.length) line('By channel', 'Not available', '');
  for (const channel of wb.sales.channelTotals) {
    line(channel.channel, moneyCell(channel.profit_cents), `${channel.count} sales. This is sales contribution, not business profit.${timing.preliminary ? ' The period is still open, so this is not a full-period comparison.' : ''}`);
  }
  if (groups.length > 1) {
    section('Each period in this file');
    for (const group of groups) {
      const monthProfit = profitStatement(group.workbook).find((row) => row.role === 'profit');
      line(group.label, show(monthProfit?.cents), 'Business profit for that slice. A slice that is still open is not a finished month.');
    }
  } else {
    line('Previous period', 'Not available', 'This file has one period, so a comparison is not included.');
  }
  section('Read this before relying on the file');
  const issues = [
    timing.preliminary ? `${timing.status}. ${timing.cutoff}` : '',
    costs.unknownSales ? `${costs.unknownSales} sales have no item cost, so business profit does not include them.` : '',
    costs.receivedMissing ? `${costs.receivedMissing} inventoried units have no cost, so the received cost total is incomplete.` : '',
    comm.gap ? `Commission deducted in profit does not equal Paul and Jacob combined. The difference is on the Profits and Payouts tabs and is unresolved.` : '',
    flow.ties ? '' : 'The inventory movement does not equal the closing count.',
    open ? 'Open returns are listed and are not in profit yet.' : '',
  ].filter(Boolean);
  if (!issues.length) issues.push('The checks this file can do did not find a difference.');
  for (const text of issues) line('Note', text, '');
  section('Go to a tab');
  for (const name of ['Profits', 'Returns', 'Sales', 'Expenses', 'Inventory', 'Payouts', 'Received', 'Sales tax return']) {
    const row = ws.addRow([name]);
    row.getCell(1).value = { text: name, hyperlink: `#'${name}'!A1` };
    row.getCell(1).font = { color: { argb: 'FF1D4E89' }, underline: true };
  }
  fitWrappedRowHeights(ws, 4, ws.rowCount, widths, 120);
  fitTitleRows(ws, 3, widths);
  setNormalSheetView(ws);
  setupPrint(ws, 4, { repeatHeader: false });
}

function writeProfitSheet(
  book: ExcelJS.Workbook,
  wb: BooksWorkbook,
  groups: SpanSlice[],
  periodLabel: string,
  generated: Date,
) {
  const ws = book.addWorksheet('Profits');
  const widths = [36, 16, 78];
  setColumnWidths(ws, widths);
  addReportTitle(ws, 'Profits', periodLabel, generated, 3);
  const headerAt = ws.rowCount + 1;
  ws.addRow(['', 'Amount', 'What this line means']);
  styleHeaderRow(ws, headerAt, 3);
  const statement = profitStatement(wb);
  const writeLines = (lines: ProfitLine[]) => {
    const start = ws.rowCount + 1;
    for (const line of lines) {
      const cents = line.role === 'deduction' ? -line.cents : line.cents;
      const row = ws.addRow([line.label, line.text ?? moneyCell(cents), line.note]);
      if (!line.text) row.getCell(2).numFmt = MONEY_FMT;
      row.getCell(1).alignment = { vertical: 'middle', wrapText: true };
      row.getCell(3).alignment = { vertical: 'middle', wrapText: true };
      if (line.role === 'subtotal' || line.role === 'profit') {
        row.font = { bold: true };
        row.border = { top: { style: line.role === 'profit' ? 'medium' : 'thin' } };
      }
    }
    if (start <= ws.rowCount) bandRows(ws, start, ws.rowCount);
  };
  writeLines(statement.filter((line) => line.role === 'amount' || line.role === 'deduction' || line.role === 'subtotal' || line.role === 'profit'));
  const info = statement.filter((line) => line.role === 'info');
  if (info.length) {
    ws.addRow([]);
    const head = ws.addRow(['Not part of the profit math']);
    head.font = { bold: true, size: 12 };
    writeLines(info);
  }
  const recon = statement.filter((line) => line.role === 'reconcile');
  if (recon.length) {
    ws.addRow([]);
    const head = ws.addRow(['How these profit figures relate']);
    head.font = { bold: true, size: 12 };
    writeLines(recon);
  }
  fitWrappedRowHeights(ws, headerAt, ws.rowCount, widths, 78);
  if (groups.length > 1) {
    ws.addRow([]);
    const head = ws.addRow(['Each month']);
    head.font = { bold: true, size: 12 };
    for (const group of groups) {
      const profit = profitStatement(group.workbook).find((line) => line.role === 'profit');
      const row = ws.addRow([group.label, moneyCell(profit?.cents ?? 0), '']);
      row.getCell(2).numFmt = MONEY_FMT;
      row.font = { bold: true };
    }
  }
  fitTitleRows(ws, 3, widths);
  setNormalSheetView(ws);
  freezeHeader(ws, headerAt);
  setupPrint(ws, headerAt, { repeatHeader: true });
}

function writeReturnsSheet(book: ExcelJS.Workbook, groups: SpanSlice[], periodLabel: string, generated: Date) {
  const ws = book.addWorksheet('Returns');
  const header = ['Date recorded', 'SKU', 'Item', 'Order', 'Channel', 'Status', 'What happened to the item', 'Refund recorded', 'Return shipping', 'Refund deducted in this report?', 'Return shipping deducted?'];
  const widths = [14, 12, 28, 16, 14, 22, 28, 16, 16, 18, 18];
  setColumnWidths(ws, widths);
  addReportTitle(ws, 'Returns', periodLabel, generated, header.length);
  const note = ws.addRow(['The date is when the return was recorded, in Pacific time. Original sale date, separate request and receipt dates, and fee credits are not on this export. Yes under refund deducted means the sale was voided and the refund is in this report\'s profit. Not yet means it is still open and is not deducted. An open return is not treated as back in stock. Return shipping is deducted unless the return was canceled.']);
  mergeLabelRow(ws, note.number, 1, header.length, String(note.getCell(1).value || ''));
  note.getCell(1).alignment = { wrapText: true, vertical: 'middle' };
  note.height = 48;
  let headerAt = 0;
  for (const group of groups) {
    const titles = new Map<string, string>();
    for (const item of group.workbook.inventory?.owner?.returns || []) {
      if (item.sku && item.title) titles.set(String(item.sku), String(item.title));
    }
    const rows = returnSheetRows(group.workbook.inventory?.returns || [], titles);
    if (group.label) {
      ws.addRow([]);
      const head = ws.addRow([group.label]);
      mergeLabelRow(ws, head.number, 1, header.length, group.label);
      head.font = { bold: true, size: 12 };
    }
    ws.addRow(header);
    headerAt = headerAt || ws.rowCount;
    styleHeaderRow(ws, ws.rowCount, header.length);
    const start = ws.rowCount + 1;
    if (!rows.length) {
      const empty = ws.addRow(['No returns']);
      mergeLabelRow(ws, empty.number, 1, header.length, 'No returns');
    }
    for (const row of rows) {
      const line = ws.addRow([
        excelDate(row.date),
        row.sku,
        row.title,
        row.order,
        row.channel,
        row.status,
        row.what,
        moneyCell(row.refundCents),
        moneyCell(row.labelCents),
        row.inProfit,
        row.shippingDeducted,
      ]);
      line.getCell(1).numFmt = 'mmm d, yyyy';
      line.getCell(8).numFmt = MONEY_FMT;
      line.getCell(9).numFmt = MONEY_FMT;
    }
    if (rows.length) {
      const taken = rows.filter((row) => row.inProfit === 'Yes').reduce((sum, row) => sum + row.refundCents, 0);
      const open = rows.filter((row) => row.inProfit === 'Not yet').reduce((sum, row) => sum + row.refundCents, 0);
      const skipped = rows.filter((row) => row.inProfit === 'No').reduce((sum, row) => sum + row.refundCents, 0);
      const labels = rows.filter((row) => row.shippingDeducted === 'Yes').reduce((sum, row) => sum + row.labelCents, 0);
      const addTotal = (label: string, refund: number | null, shipping: number | null) => {
        const total = ws.addRow(['', '', '', '', '', '', label, refund == null ? null : moneyCell(refund), shipping == null ? null : moneyCell(shipping), '', '']);
        total.font = { bold: true };
        if (refund != null) total.getCell(8).numFmt = MONEY_FMT;
        if (shipping != null) total.getCell(9).numFmt = MONEY_FMT;
      };
      addTotal('Refunds taken out on Profits', taken, null);
      addTotal('Open, not taken out yet', open, null);
      if (skipped) addTotal('Denied or canceled', skipped, null);
      addTotal('Return shipping taken out on Profits', null, labels);
    }
    if (start <= ws.rowCount) bandRows(ws, start, ws.rowCount);
  }
  fitTitleRows(ws, header.length, widths);
  setNormalSheetView(ws);
  if (headerAt) {
    ws.autoFilter = { from: { row: headerAt, column: 1 }, to: { row: ws.rowCount, column: header.length } };
    freezeHeader(ws, headerAt, 2);
  }
  setupPrint(ws, headerAt || 4, { repeatHeader: true });
}

type ReceivedGroup = { label: string; items: ReceivedItem[]; manifested: number };

function writeReceivedSheet(book: ExcelJS.Workbook, groups: ReceivedGroup[], periodLabel: string, generated: Date) {
  const ws = book.addWorksheet('Received');
  const cols = 3;
  const widths = [42, 14, 16];
  setColumnWidths(ws, widths);
  addReportTitle(ws, 'Items inventoried', periodLabel, generated, cols);
  const receivedNote = 'An item record is one inventoried SKU. Units are the quantity on those records. Manifested is the count written on manifests in this period, which is not the same as units scanned into stock. Cost is the acquisition cost of records that have a cost. A blank cost is missing. A cost of $0.00 is a real zero. The Inventory tab Received row is the inventory movement, which can differ from this list.';
  const note = ws.addRow([receivedNote]);
  mergeLabelRow(ws, note.number, 1, cols, receivedNote);
  note.height = 72;
  const headerAt = ws.rowCount + 1;
  const writeBlock = (items: ReceivedItem[], manifested: number) => {
    ws.addRow(['', 'Count', 'Cost']);
    styleHeaderRow(ws, ws.rowCount, cols);
    const start = ws.rowCount + 1;
    for (const metric of receivedSheetMetrics(items, manifested)) {
      const row = ws.addRow([metric.label, metric.count, metric.cents == null ? null : moneyCell(metric.cents)]);
      row.height = 18;
      if (metric.cents != null) row.getCell(3).numFmt = MONEY_FMT;
    }
    bandRows(ws, start, ws.rowCount);
  };
  for (const group of groups) {
    if (group.label) {
      ws.addRow([]);
      const head = ws.addRow([group.label]);
      mergeLabelRow(ws, head.number, 1, cols, group.label);
      head.font = { bold: true, size: 12 };
    }
    writeBlock(group.items, group.manifested);
  }
  const missingItems = groups.flatMap((group) => group.items.filter((item) => {
    const cost = item.cost_cents;
    return cost == null || cost === '' || !Number.isFinite(Number(cost));
  }));
  ws.addRow([]);
  const missHead = ws.addRow(['Records with no cost']);
  mergeLabelRow(ws, missHead.number, 1, cols, 'Records with no cost');
  missHead.font = { bold: true, size: 12 };
  const missNote = ws.addRow(['These inventoried records have no acquisition cost. A recorded cost of $0.00 is not on this list. Nothing was estimated. Fix the item record and the next report will include the cost.']);
  mergeLabelRow(ws, missNote.number, 1, cols, String(missNote.getCell(1).value || ''));
  missNote.height = 32;
  const missHeader = ws.rowCount + 1;
  ws.addRow(['SKU', 'Item', 'Units']);
  styleHeaderRow(ws, missHeader, cols);
  if (!missingItems.length) {
    const none = ws.addRow(['None']);
    mergeLabelRow(ws, none.number, 1, cols, 'None');
  }
  for (const item of missingItems) {
    ws.addRow([String(item.sku || ''), String(item.title || ''), Math.max(1, Number(item.qty_on_hand || 1))]);
  }
  if (missingItems.length) {
    ws.autoFilter = { from: { row: missHeader, column: 1 }, to: { row: ws.rowCount, column: cols } };
  }
  fitTitleRows(ws, cols, widths);
  setNormalSheetView(ws);
  freezeHeader(ws, headerAt, 1);
  setupPrint(ws, headerAt, { repeatHeader: true });
}

/** Swap the SKU list on a locked export for the same counts, leaving the other sheets alone. */
export async function replaceReceivedSheet(bytes: Uint8Array, items: ReceivedItem[], periodLabel: string, manifested = 0) {
  const book = new ExcelJS.Workbook();
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  await book.xlsx.load(copy);
  const existing = book.getWorksheet('Received') || book.getWorksheet('Items received');
  if (existing) book.removeWorksheet(existing.id);
  writeReceivedSheet(book, [{ label: '', items, manifested }], periodLabel, new Date());
  const out = await book.xlsx.writeBuffer();
  return new Uint8Array(out);
}

function pdfText(value: unknown) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E\n\r\t]/g, '?');
}

export async function buildBooksPdf(period: Period, wb: BooksWorkbook, money: (c: number) => string, options?: ExportOptions) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 792;
  const pageHeight = 612;
  const margin = 34;
  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;
  const title = options?.title || formatPeriodTitle(period.period_start);
  const slices = options?.slices && options.slices.length > 1 ? options.slices : null;
  const newPage = (section: string) => {
    page = pdf.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
    page.drawText(section, { x: margin, y, size: 12, font: bold });
    y -= 18;
  };
  const line = (text: string, strong = false) => {
    const f = strong ? bold : font;
    if (y < margin + 14) newPage('(continued)');
    page.drawText(pdfText(text).slice(0, 140), { x: margin, y, size: 8, font: f, color: rgb(0.1, 0.13, 0.18) });
    y -= 11;
  };

  const warn = tieWarning(wb);
  page.drawText('Open Box Industries — Books', { x: margin, y, size: 16, font: bold });
  y -= 20;
  page.drawText(`${title} · ${period.period_start} to ${period.period_end}`, { x: margin, y, size: 10, font });
  y -= 16;
  if (warn) { line(`These numbers don't tie: ${warn}`, true); y -= 4; }
  const t = wb.sales.totals;
  const p = wb.payouts;
  line(`Sales ${money(t.revenue)} · COGS ${money(t.cost)} · Fees+labels ${money(t.feesAndLabels)} · Profit ${money(t.profit)} · Commission ${money(t.commission)} · Other expenses ${money(t.otherExpenses)} · Owner keeps ${money(p.owner.ownerKeeps)}`, true);
  if (slices) {
    for (const slice of slices) {
      const s = slice.workbook.sales.totals;
      line(`${slice.label}: sales ${money(s.revenue)} · profit ${money(s.profit)} · commission ${money(s.commission)} · owner keeps ${money(slice.workbook.payouts.owner.ownerKeeps)}`);
    }
  }

  newPage('Expenses');
  for (const r of wb.expenses.exportRows.slice(0, 80)) line(`${r.date} · ${r.category} · ${r.description} · ${money(r.amount_cents)}`);
  line(`Grand total ${money(wb.expenses.total_cents)}`, true);

  newPage('Sales');
  for (const r of wb.sales.rows.slice(0, 100)) {
    line(`${r.date} · ${r.sku} · ${r.channel} · ${money(r.price_cents)} · profit ${r.profit_cents == null ? '—' : money(r.profit_cents)}${r.profit_notes ? ` · ${r.profit_notes}` : ''}`);
  }

  newPage('Inventory summary');
  line(`Start ${invMetric(wb.inventory.start_unit_count)} · End ${invMetric(wb.inventory.end_unit_count)}`);
  line(`Sold ${wb.inventory.sold_units} · Received ${wb.inventory.received_units} · Manifested ${wb.manifested_units || 0} · Giveaways ${wb.inventory.giveaway_units}`);

  newPage('Payouts');
  const bankSum = p.stores.reduce((n, s) => n + s.paid_to_bank_cents, 0);
  line(`Paid to bank ${money(bankSum)}`, true);
  for (const s of p.stores) line(`${s.label} · in ${money(s.money_in_cents)} · bank ${money(s.paid_to_bank_cents)}`);
  for (const c of p.commissions.filter((x) => x.role === 'staff')) line(`${c.person} earned ${money(c.earned_cents)} · paid ${money(c.paid_cents)}`);
  line(`Owner keeps ${money(p.owner.ownerKeeps)}`, true);

  const pages = pdf.getPages();
  pages.forEach((pg, i) => pg.drawText(`Page ${i + 1} of ${pages.length}`, { x: margin, y: 12, size: 8, font }));
  return pdf.save();
}

function invMetric(n: number) { return String(n ?? '—'); }

export function downloadBytes(name: string, data: ArrayBuffer | Uint8Array, type: string) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function bytesBase64(buffer: ArrayBuffer | Uint8Array) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
