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
import { rollupRareCategories } from './inventoryCategories';
import { liveListedChannels, notListedLines } from './sheetChannels';
import type { BooksWorkbook, ExpenseDisplayLine, Period } from './types';

function tieWarning(wb: BooksWorkbook) {
  const issues = wb.exportTieIssues ?? verifyExportTies(wb);
  return issues.length ? issues.map((i) => i.message).join('; ') : undefined;
}

export async function buildBooksExcel(period: Period, wb: BooksWorkbook, label: string) {
  const x = new ExcelJS.Workbook();
  x.creator = 'Floor Books';
  x.subject = label;
  const periodLabel = formatPeriodTitle(period.period_start);
  const generated = new Date();

  const wsS = x.addWorksheet('Sales');
  const salesHeader = [
    'Date', 'SKU', 'Item', 'Channel', 'Order #', 'Sale price', 'Sales tax', 'Marketplace fees',
    'Card fee', 'Shipping label (we paid)', 'Buyer paid shipping', 'Item cost', 'Profit', 'Commission', 'Notes',
  ];
  const salesCols = salesHeader.length;
  const salesWidths = [14, 10, 38, 14, 16, 12, 11, 18, 12, 20, 20, 11, 11, 12, 40];
  setColumnWidths(wsS, salesWidths);
  addReportTitle(wsS, 'Sales', periodLabel, generated, salesCols);
  fitTitleRows(wsS, salesCols, salesWidths);
  const hS = wsS.rowCount + 1;
  wsS.addRow(salesHeader);
  styleHeaderRow(wsS, hS, salesHeader.length);
  const dataStartS = hS + 1;
  for (const r of wb.sales.rows) {
    wsS.addRow([
      excelDate(r.date),
      r.sku,
      r.title,
      r.channel,
      r.order_no,
      moneyCell(r.price_cents),
      moneyCell(r.tax_cents),
      moneyCell(r.marketplace_fees_cents),
      moneyCell(r.card_fees_cents),
      moneyCell(r.label_cost_cents),
      moneyCell(r.buyer_shipping_cents),
      moneyCell(r.cost_cents),
      moneyCell(r.profit_cents),
      moneyCell(r.commission_cents),
      r.profit_notes,
    ]);
  }
  const dataEndS = wsS.rowCount;
  bandRows(wsS, dataStartS, dataEndS);
  wrapDataRows(wsS, dataStartS, dataEndS, salesCols);
  fitWrappedRowHeights(wsS, hS, dataEndS, salesWidths);
  for (let r = dataStartS; r <= dataEndS; r++) {
    const row = wsS.getRow(r);
    row.getCell(1).numFmt = 'mmm d, yyyy';
    for (const c of [6, 7, 8, 9, 10, 11, 12, 13, 14]) {
      if (row.getCell(c).value != null) row.getCell(c).numFmt = MONEY_FMT;
    }
  }
  wsS.addRow([]);
  for (const c of wb.sales.channelTotals) {
    const row = wsS.addRow(['', '', '', '', '', '', moneyCell(c.revenue_cents), '', '', '', '', '', moneyCell(c.profit_cents), '', '']);
    mergeLabelRow(wsS, row.number, 1, 6, `${c.channel} subtotal`);
    row.font = { bold: true };
    row.getCell(7).numFmt = MONEY_FMT;
    row.getCell(13).numFmt = MONEY_FMT;
  }
  const t = wb.sales.totals;
  const tot = wsS.addRow(['', '', '', '', '', '', moneyCell(t.revenue), '', '', '', '', moneyCell(t.cost), moneyCell(t.profit), moneyCell(t.commission), '']);
  mergeLabelRow(wsS, tot.number, 1, 6, 'Period grand total');
  tot.font = { bold: true };
  tot.border = { top: { style: 'medium' } };
  for (const c of [7, 12, 13, 14]) tot.getCell(c).numFmt = MONEY_FMT;
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
  setupPrint(wsS, hS);

  const wsE = x.addWorksheet('Expenses');
  const expHeader = ['Date', 'Category', 'Description', 'Amount', 'SKU / Order #', 'Paid by', 'Reimburse?'];
  const expCols = expHeader.length;
  const expWidths = [16, 28, 52, 14, 18, 18, 14];
  setColumnWidths(wsE, expWidths);
  addReportTitle(wsE, 'Expenses', periodLabel, generated, expCols);
  fitTitleRows(wsE, expCols, expWidths);
  const hE = wsE.rowCount + 1;
  wsE.addRow(expHeader);
  styleHeaderRow(wsE, hE, expHeader.length);
  const dupLines: ExpenseDisplayLine[] = wb.expenses.rows.filter((r) => r.duplicateFlag || (r.excludeFromTotals && r.duplicateFlag));
  const startE = hE + 1;
  for (const r of wb.expenses.exportRows) {
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
  setupPrint(wsE, hE);

  const wsI = x.addWorksheet('Inventory');
  const invCols = 7;
  const invWidths = [12, 28, 14, 14, 12, 14, 18];
  setColumnWidths(wsI, invWidths);
  addReportTitle(wsI, 'Inventory', periodLabel, generated, invCols);
  fitTitleRows(wsI, invCols, invWidths);
  const inv = wb.inventory;
  const metrics: [string, number, string][] = [
    ['Units in stock at start of month', inv.start_unit_count, inv.start_source === 'snapshot' ? 'Month snapshot' : 'Estimated: end of month minus this month\'s movement, because no start snapshot exists yet'],
    ['Units received', inv.received_units, ''],
    ['Units sold', inv.sold_units, ''],
    ['Returned to stock', inv.return_to_stock_units ?? 0, ''],
    ['Given away', inv.giveaway_units, ''],
    ['Sent as replacements', inv.replacement_units, ''],
    ['Moved to Defective', inv.defective_units, 'Units pulled into defective this month'],
    ['Defective items on hand', inv.owner?.defective_shelf?.units ?? 0, 'Same count as Inventory → Defective'],
    ['Units in stock at end of month', inv.end_unit_count, inv.end_source === 'snapshot' ? 'Month snapshot' : 'Estimated: current on-hand count, because this month is not closed'],
  ];
  const hI = wsI.rowCount + 1;
  wsI.addRow(['Metric', 'Units', 'Note']);
  styleHeaderRow(wsI, hI, 3);
  const mStart = hI + 1;
  for (const [metric, value, note] of metrics) wsI.addRow([metric, value, note]);
  bandRows(wsI, mStart, wsI.rowCount);
  wrapDataRows(wsI, mStart, wsI.rowCount, 3);
  fitWrappedRowHeights(wsI, mStart, wsI.rowCount, invWidths);
  const own = inv.owner;
  if (own?.value) {
    wsI.addRow([]);
    const shelf = wsI.addRow(['Shelf value']);
    mergeLabelRow(wsI, shelf.number, 1, invCols, 'Shelf value');
    shelf.font = { bold: true };
    wsI.addRow(['', 'Units', 'Cost', 'Floor price']);
    const endRow = wsI.addRow(['End of month', own.value.end_units, moneyCell(own.value.end_cost_cents), moneyCell(own.value.end_floor_cents)]);
    endRow.getCell(3).numFmt = MONEY_FMT;
    endRow.getCell(4).numFmt = MONEY_FMT;
    const startRow = wsI.addRow(['Start of month', own.value.start_units, moneyCell(own.value.start_cost_cents), moneyCell(own.value.start_floor_cents ?? null)]);
    startRow.getCell(3).numFmt = MONEY_FMT;
    if (own.value.start_floor_cents != null) startRow.getCell(4).numFmt = MONEY_FMT;
    if (own.value.start_note) {
      const note = wsI.addRow([own.value.start_note]);
      mergeLabelRow(wsI, note.number, 1, invCols, own.value.start_note);
    }
  }
  const writePairs = (title: string, headers: string[], rows: (string | number | null)[][]) => {
    wsI.addRow([]);
    const b = wsI.addRow([title]);
    mergeLabelRow(wsI, b.number, 1, invCols, title);
    b.font = { bold: true };
    if (!rows.length) { wsI.addRow(['None']); return; }
    wsI.addRow(headers);
    for (const cells of rows) {
      const row = wsI.addRow(cells);
      cells.forEach((cell, i) => {
        if (typeof cell === 'number' && headers[i]?.toLowerCase().includes('cost') || (typeof cell === 'number' && String(headers[i] || '').toLowerCase().includes('floor'))) {
          row.getCell(i + 1).numFmt = MONEY_FMT;
        }
      });
    }
  };
  if (own) {
    writePairs('By category', ['Category', 'Units', 'Cost', 'Floor', 'Sold', 'Sell-through %'],
      rollupRareCategories(own.categories || []).map((c) => [c.category, c.units, (c.cost_cents || 0) / 100, (c.floor_cents || 0) / 100, c.sold_units, c.sell_through]));
    writePairs('Listed by channel (an item on several channels is listed under each)', ['Channel', 'Units', 'Cost'],
      liveListedChannels(own.listed || []).map((c) => [c.channel, c.units, (c.cost_cents || 0) / 100]));
    const unlisted = notListedLines(own.unlisted || [], own.defective_shelf);
    writePairs('Not listed', ['', 'Units', 'Cost'], [
      ['Total', unlisted.units, unlisted.cost_cents / 100],
      ['Defective', unlisted.defective_units, unlisted.defective_cost_cents / 100],
    ]);
    writePairs('Aging', ['Bucket', 'Units', 'Cost'],
      (own.aging || []).map((c) => [c.bucket, c.units, (c.cost_cents || 0) / 100]));
    const mv = own.movement || {};
    writePairs('This month at cost', ['Movement', 'Units', 'Cost'], [
      ['Received', mv.received_units || 0, (mv.received_cost_cents || 0) / 100],
      ['Sold', mv.sold_units || 0, (mv.sold_cost_cents || 0) / 100],
      ['Returned to stock', mv.return_to_stock_units || 0, (mv.return_to_stock_cost_cents || 0) / 100],
      ['Given away', mv.giveaway_units || 0, (mv.giveaway_cost_cents || 0) / 100],
      ['Replacements', mv.replacement_units || 0, (mv.replacement_cost_cents || 0) / 100],
      ['Moved to Defective', mv.defective_units || 0, (mv.defective_cost_cents || 0) / 100],
    ]);
    writePairs('Slowest movers', ['SKU', 'Item', 'Days', 'Cost', 'Floor', 'Listed'],
      (own.slowest || []).map((s) => [s.sku, s.title, s.days ?? '', (s.cost_cents || 0) / 100, (s.floor_cents || 0) / 100, s.listed || 'not listed']));
  }
  const sectionBanner = (title: string) => {
    wsI.addRow([]);
    const row = wsI.addRow([title]);
    mergeLabelRow(wsI, row.number, 1, invCols, title);
    row.font = { bold: true, size: 12 };
  };
  sectionBanner('Giveaways');
  const hGive = wsI.rowCount + 1;
  wsI.addRow(['SKU', 'Item', 'Cost', 'Given to', 'Date']);
  styleHeaderRow(wsI, hGive, 5);
  const giveStart = hGive + 1;
  for (const g of inv.giveaways || []) {
    const row = wsI.addRow([g.sku, g.title, moneyCell(Number(g.cost_cents)), g.given_to, excelDate(String(g.date || ''))]);
    row.getCell(3).numFmt = MONEY_FMT;
    row.getCell(5).numFmt = 'mmm d, yyyy';
  }
  if (!(inv.giveaways || []).length) wsI.addRow(['None this month']);
  else {
    wrapDataRows(wsI, giveStart, wsI.rowCount, 5);
    fitWrappedRowHeights(wsI, hGive, wsI.rowCount, invWidths);
  }
  sectionBanner('Replacements');
  const hRepl = wsI.rowCount + 1;
  wsI.addRow(['SKU', 'Item', 'Original sale', 'Bad unit', 'Extra cost', 'Date']);
  styleHeaderRow(wsI, hRepl, 6);
  const replStart = hRepl + 1;
  for (const r of inv.replacements || []) {
    const row = wsI.addRow([r.sku, r.title, r.original_sale_id, r.bad_unit_status, moneyCell(Number(r.extra_cost_cents || 0)), excelDate(String(r.date || ''))]);
    row.getCell(5).numFmt = MONEY_FMT;
  }
  if (!(inv.replacements || []).length) wsI.addRow(['None this month']);
  else {
    wrapDataRows(wsI, replStart, wsI.rowCount, 6);
    fitWrappedRowHeights(wsI, hRepl, wsI.rowCount, invWidths);
  }
  sectionBanner('Returns');
  const hRet = wsI.rowCount + 1;
  wsI.addRow(['SKU', 'Order', 'Channel', 'Refund', 'Label', 'Status', 'Disposition']);
  styleHeaderRow(wsI, hRet, invCols);
  const retStart = hRet + 1;
  for (const r of inv.returns || []) {
    const row = wsI.addRow([r.sku, r.order_id, r.channel, moneyCell(Number(r.refund_cents || 0)), moneyCell(Number(r.label_cents || 0)), r.status, r.disposition || r.route_to]);
    row.getCell(4).numFmt = MONEY_FMT;
    row.getCell(5).numFmt = MONEY_FMT;
  }
  if (!(inv.returns || []).length) wsI.addRow(['None this month']);
  else {
    wrapDataRows(wsI, retStart, wsI.rowCount, invCols);
    fitWrappedRowHeights(wsI, hRet, wsI.rowCount, invWidths);
  }
  fitTitleRows(wsI, invCols, invWidths);
  setNormalSheetView(wsI);
  setupPrint(wsI, hI);

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

  const wsR = x.addWorksheet('Received');
  const recHeader = ['Date received', 'SKU', 'Item', 'Brand', 'Category', 'Condition', 'Qty', 'Cost', 'Floor price', 'Location', 'Received by', 'Current status'];
  const recWidths = [14, 10, 36, 14, 16, 12, 6, 11, 11, 14, 14, 14];
  setColumnWidths(wsR, recWidths);
  addReportTitle(wsR, 'Items received', periodLabel, generated, recHeader.length);
  fitTitleRows(wsR, recHeader.length, recWidths);
  const hR = wsR.rowCount + 1;
  wsR.addRow(recHeader);
  styleHeaderRow(wsR, hR, recHeader.length);
  const rStart = hR + 1;
  for (const r of wb.received) {
    wsR.addRow([
      excelDate(String(r.received_at || '')),
      r.sku,
      r.title,
      r.brand,
      r.category,
      r.condition,
      r.qty_on_hand,
      moneyCell(Number(r.cost_cents)),
      moneyCell(Number(r.ask_cents)),
      r.location,
      r.receiver_name,
      r.listing_status,
    ]);
  }
  bandRows(wsR, rStart, wsR.rowCount);
  wrapDataRows(wsR, hR, wsR.rowCount, recHeader.length);
  fitWrappedRowHeights(wsR, hR, wsR.rowCount, recWidths);
  for (let r = rStart; r <= wsR.rowCount; r++) {
    wsR.getRow(r).getCell(1).numFmt = 'mmm d, yyyy';
    wsR.getRow(r).getCell(8).numFmt = MONEY_FMT;
    wsR.getRow(r).getCell(9).numFmt = MONEY_FMT;
  }
  fitTitleRows(wsR, recHeader.length, recWidths);
  setNormalSheetView(wsR);
  setupPrint(wsR, hR);

  return x.xlsx.writeBuffer();
}

function pdfText(value: unknown) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E\n\r\t]/g, '?');
}

export async function buildBooksPdf(period: Period, wb: BooksWorkbook, money: (c: number) => string) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 792;
  const pageHeight = 612;
  const margin = 34;
  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;
  const title = formatPeriodTitle(period.period_start);
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

  newPage('Expenses');
  for (const r of wb.expenses.exportRows.slice(0, 80)) line(`${r.date} · ${r.category} · ${r.description} · ${money(r.amount_cents)}`);
  line(`Grand total ${money(wb.expenses.total_cents)}`, true);

  newPage('Sales');
  for (const r of wb.sales.rows.slice(0, 100)) {
    line(`${r.date} · ${r.sku} · ${r.channel} · ${money(r.price_cents)} · profit ${r.profit_cents == null ? '—' : money(r.profit_cents)}${r.profit_notes ? ` · ${r.profit_notes}` : ''}`);
  }

  newPage('Inventory summary');
  line(`Start ${invMetric(wb.inventory.start_unit_count)} · End ${invMetric(wb.inventory.end_unit_count)}`);
  line(`Sold ${wb.inventory.sold_units} · Received ${wb.inventory.received_units} · Giveaways ${wb.inventory.giveaway_units}`);

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
