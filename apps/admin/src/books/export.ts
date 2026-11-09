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
} from './exportFormat';
import { verifyExportTies } from './exportChecks';
import type { BooksWorkbook, ExpenseDisplayLine, Period, ReceivedItem } from './types';
import { receivedSheetMetrics } from './receivedSummary';

type SpanSlice = { label: string; workbook: BooksWorkbook };
type ExportOptions = { title?: string; slices?: SpanSlice[]; word?: string };

function tieWarning(wb: BooksWorkbook) {
  const issues = wb.exportTieIssues ?? verifyExportTies(wb);
  return issues.length ? issues.map((i) => i.message).join('; ') : undefined;
}

export async function buildBooksExcel(period: Period, wb: BooksWorkbook, label: string, options?: ExportOptions) {
  const x = new ExcelJS.Workbook();
  x.creator = 'Floor Books';
  x.subject = label;
  const periodLabel = options?.title || formatPeriodTitle(period.period_start);
  const slices = options?.slices && options.slices.length > 1 ? options.slices : null;
  const word = options?.word || 'month';
  const generated = new Date();

  const wsS = x.addWorksheet('Sales');
  const salesHeader = [
    'Date', 'SKU', 'Item', 'Channel', 'Sale price', 'Fees', 'Item cost', 'Profit',
    'Order #', 'Sales tax', 'Card fee', 'Shipping label (we paid)', 'Buyer paid shipping', 'Commission', 'Notes',
  ];
  const salesCols = salesHeader.length;
  const salesWidths = [12, 9, 32, 12, 12, 12, 12, 12, 14, 11, 11, 16, 16, 12, 28];
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
      moneyCell(r.cost_cents),
      moneyCell(r.profit_cents),
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
      const sub = group.workbook.sales.totals;
      const row = wsS.addRow(['', '', '', '', moneyCell(sub.revenue), '', moneyCell(sub.cost), moneyCell(sub.profit), '', '', '', '', '', moneyCell(sub.commission), '']);
      mergeLabelRow(wsS, row.number, 1, 4, `${group.label} subtotal`);
      row.font = { bold: true };
      for (const c of [5, 7, 8, 14]) row.getCell(c).numFmt = MONEY_FMT;
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
  for (const c of wb.sales.channelTotals) {
    const row = wsS.addRow(['', '', '', '', moneyCell(c.revenue_cents), '', '', moneyCell(c.profit_cents)]);
    mergeLabelRow(wsS, row.number, 1, 4, `${c.channel} subtotal`);
    row.font = { bold: true };
    row.getCell(5).numFmt = MONEY_FMT;
    row.getCell(8).numFmt = MONEY_FMT;
  }
  const t = wb.sales.totals;
  const tot = wsS.addRow(['', '', '', '', moneyCell(t.revenue), '', moneyCell(t.cost), moneyCell(t.profit), '', '', '', '', '', moneyCell(t.commission), '']);
  mergeLabelRow(wsS, tot.number, 1, 4, 'Period grand total');
  tot.font = { bold: true };
  tot.border = { top: { style: 'medium' } };
  for (const c of [5, 7, 8, 14]) tot.getCell(c).numFmt = MONEY_FMT;
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
  setupPrint(wsS, hS, { repeatHeader: true, printThroughColumn: 'H' });

  const wsE = x.addWorksheet('Expenses');
  const expHeader = ['Date', 'Category', 'Description', 'Amount', 'SKU / Order #', 'Paid by', 'Reimburse?'];
  const expCols = expHeader.length;
  const expWidths = [12, 16, 32, 12, 14, 16, 12];
  setColumnWidths(wsE, expWidths);
  addReportTitle(wsE, 'Expenses', periodLabel, generated, expCols);
  fitTitleRows(wsE, expCols, expWidths);
  const hE = wsE.rowCount + 1;
  wsE.addRow(expHeader);
  styleHeaderRow(wsE, hE, expHeader.length);
  const dupLines: ExpenseDisplayLine[] = wb.expenses.rows.filter((r) => r.duplicateFlag || (r.excludeFromTotals && r.duplicateFlag));
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
  if (dupLines.length || wb.expenses.duplicates.length) {
    wsE.addRow([]);
    const dupBanner = wsE.addRow(['Possible duplicates — extra copy is not counted. The kept row stays in the list above.']);
    mergeLabelRow(wsE, dupBanner.number, 1, expCols, 'Possible duplicates — extra copy is not counted. The kept row stays in the list above.');
    dupBanner.font = { bold: true };
    const dupH = wsE.rowCount + 1;
    wsE.addRow(['', 'Date', 'Category', 'Description', 'Amount']);
    styleHeaderRow(wsE, dupH, 5);
    const dupStart = dupH + 1;
    for (const d of wb.expenses.duplicates) {
      const kept = d.pair?.primary;
      const extra = d.pair?.duplicate;
      if (!extra) continue;
      const keptRow = wsE.addRow(['Kept', excelDate(String(kept?.date || '')), kept?.category || '', kept?.title || '', moneyCell(kept?.amount_cents ?? null)]);
      keptRow.getCell(2).numFmt = 'mmm d, yyyy';
      keptRow.getCell(5).numFmt = MONEY_FMT;
      const extraRow = wsE.addRow(['Extra (not counted)', excelDate(String(extra.date || '')), extra.category, extra.title, moneyCell(extra.amount_cents)]);
      extraRow.getCell(2).numFmt = 'mmm d, yyyy';
      extraRow.getCell(5).numFmt = MONEY_FMT;
    }
    wrapDataRows(wsE, dupStart, wsE.rowCount, 5);
    fitWrappedRowHeights(wsE, dupH, wsE.rowCount, expWidths);
  }
  fitTitleRows(wsE, expCols, expWidths);
  setNormalSheetView(wsE);
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
  bandRows(wsI, hI + 1, wsI.rowCount);
  fitTitleRows(wsI, 3, invWidths);
  setNormalSheetView(wsI);
  setupPrint(wsI, hI, { onePage: true });

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
      const row = wsP.addRow([
        excelDate(String(t.at || '').slice(0, 10)),
        s.label,
        moneyCell(t.amount_cents),
        String(t.note || t.reason || ''),
        s.account === 'safe' ? String(t.reason || '') : '',
      ]);
      row.getCell(1).numFmt = 'mmm d, yyyy';
      row.getCell(3).numFmt = MONEY_FMT;
    }
  }
  const logged = p.stores.reduce((n, s) => n + (s.transfers || []).reduce((a, t) => a + t.amount_cents, 0), 0);
  const logTot = wsP.addRow(['Total paid out', '', moneyCell(logged), logged === sumOut ? 'Ties to Paid out' : 'Does not tie to Paid out', '']);
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
  wsP.addRow(['Commissions (Paul & Jacob)']).font = { bold: true, size: 12 };
  wsP.addRow(['Person', 'Earned this month', 'Paid this month', 'Still owed (all time)']);
  styleHeaderRow(wsP, wsP.rowCount, 4);
  const commStart = wsP.rowCount + 1;
  for (const c of p.commissions.filter((x) => x.role === 'staff')) {
    wsP.addRow([c.person, moneyCell(c.earned_cents), moneyCell(c.paid_cents), moneyCell(c.owed_all_time_cents)]);
  }
  for (let r = commStart; r <= wsP.rowCount; r++) {
    for (const c of [2, 3, 4]) wsP.getRow(r).getCell(c).numFmt = MONEY_FMT;
  }
  wsP.addRow([]);
  wsP.addRow(['Owner']).font = { bold: true, size: 12 };
  const ok = p.owner;
  for (const [label, cents] of [
    ['Profit', ok.profit],
    ['− Commissions', ok.commission],
    ['− Other expenses', ok.otherExpenses],
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

type ReceivedGroup = { label: string; items: ReceivedItem[]; manifested: number };

function writeReceivedSheet(book: ExcelJS.Workbook, groups: ReceivedGroup[], periodLabel: string, generated: Date) {
  const ws = book.addWorksheet('Received');
  const cols = 3;
  const widths = [42, 14, 16];
  setColumnWidths(ws, widths);
  addReportTitle(ws, 'Items inventoried', periodLabel, generated, cols);
  const note = ws.addRow(['Counts only. Each item is still listed in Books.']);
  mergeLabelRow(ws, note.number, 1, cols, 'Counts only. Each item is still listed in Books.');
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
  fitTitleRows(ws, cols, widths);
  setNormalSheetView(ws);
  setupPrint(ws, headerAt, { onePage: true });
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
