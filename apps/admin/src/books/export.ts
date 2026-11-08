import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  MONEY_FMT,
  addReportTitle,
  bandRows,
  fitWrappedRowHeights,
  cleanSkuOrder,
  displayPaidBy,
  excelDate,
  formatPeriodTitle,
  moneyCell,
  setColumnWidths,
  setupPrint,
  styleHeaderRow,
} from './exportFormat';
import { verifyExportTies } from './exportChecks';
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
  const warn = tieWarning(wb);

  const wsS = x.addWorksheet('Sales');
  const salesHeader = [
    'Date', 'SKU', 'Item', 'Channel', 'Order #', 'Sale price', 'Sales tax', 'Marketplace fees',
    'Card fee', 'Shipping label (we paid)', 'Buyer paid shipping', 'Item cost', 'Profit', 'Commission', 'Notes',
  ];
  const salesCols = salesHeader.length;
  addReportTitle(wsS, 'Sales', periodLabel, generated, salesCols, warn);
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
  const salesWidths = [13, 9, 34, 12, 14, 12, 10, 16, 11, 18, 18, 11, 10, 11, 36];
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
    const row = wsS.addRow([`${c.channel} subtotal`, '', '', '', '', '', moneyCell(c.revenue_cents), '', '', '', '', '', moneyCell(c.profit_cents), '', '']);
    row.font = { bold: true };
    row.getCell(7).numFmt = MONEY_FMT;
    row.getCell(13).numFmt = MONEY_FMT;
  }
  const t = wb.sales.totals;
  const tot = wsS.addRow(['Period grand total', '', '', '', '', '', moneyCell(t.revenue), '', '', '', '', moneyCell(t.cost), moneyCell(t.profit), moneyCell(t.commission), '']);
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
  setColumnWidths(wsS, salesWidths);
  setupPrint(wsS, hS);

  const wsE = x.addWorksheet('Expenses');
  const expHeader = ['Date', 'Category', 'Description', 'Amount', 'SKU / Order #', 'Paid by', 'Reimburse?'];
  addReportTitle(wsE, 'Expenses', periodLabel, generated, expHeader.length);
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
  bandRows(wsE, startE, wsE.rowCount);
  wsE.addRow([]);
  for (const c of wb.expenses.categoryTotals) {
    const row = wsE.addRow([`${c.category} subtotal`, '', '', moneyCell(c.amount_cents)]);
    row.font = { bold: true };
    row.getCell(4).numFmt = MONEY_FMT;
  }
  const gt = wsE.addRow(['Grand total', '', '', moneyCell(wb.expenses.total_cents)]);
  gt.font = { bold: true };
  gt.border = { top: { style: 'medium' } };
  gt.getCell(4).numFmt = MONEY_FMT;
  if (dupLines.length || wb.expenses.duplicates.length) {
    wsE.addRow([]);
    wsE.addRow(['Possible duplicates (not counted in totals)']).font = { bold: true };
    wsE.addRow(['Date', 'Category', 'Description', 'Amount']);
    for (const d of wb.expenses.duplicates) {
      for (const line of [d.pair?.duplicate, d.pair?.primary].filter(Boolean)) {
        wsE.addRow([line!.date, line!.category, line!.title, moneyCell(line!.amount_cents)]);
      }
    }
  }
  setColumnWidths(wsE, [13, 18, 40, 12, 16, 14, 11]);
  setupPrint(wsE, hE);

  const wsI = x.addWorksheet('Inventory');
  addReportTitle(wsI, 'Inventory', periodLabel, generated, 3);
  const inv = wb.inventory;
  const metrics: [string, number, string][] = [
    ['Units in stock at start of month', inv.start_unit_count, inv.start_source === 'snapshot' ? '' : 'Estimated'],
    ['Units received', inv.received_units, ''],
    ['Units sold', inv.sold_units, ''],
    ['Returned to stock', inv.return_to_stock_units ?? 0, ''],
    ['Given away', inv.giveaway_units, ''],
    ['Sent as replacements', inv.replacement_units, ''],
    ['Moved to Defective', inv.defective_units, ''],
    ['Units in stock at end of month', inv.end_unit_count, inv.end_source === 'snapshot' ? '' : 'Estimated'],
  ];
  wsI.addRow(['Metric', 'Units', 'Note']);
  styleHeaderRow(wsI, wsI.rowCount, 3);
  const mStart = wsI.rowCount + 1;
  for (const [metric, value, note] of metrics) wsI.addRow([metric, value, note]);
  bandRows(wsI, mStart, wsI.rowCount);
  wsI.addRow([]);
  wsI.addRow(['Giveaways']).font = { bold: true };
  wsI.addRow(['SKU', 'Item', 'Cost', 'Given to', 'Date']);
  styleHeaderRow(wsI, wsI.rowCount, 5);
  for (const g of inv.giveaways || []) {
    const row = wsI.addRow([g.sku, g.title, moneyCell(Number(g.cost_cents)), g.given_to, excelDate(String(g.date || ''))]);
    row.getCell(3).numFmt = MONEY_FMT;
    row.getCell(5).numFmt = 'mmm d, yyyy';
  }
  wsI.addRow([]);
  wsI.addRow(['Replacements']).font = { bold: true };
  wsI.addRow(['SKU', 'Item', 'Original sale', 'Bad unit', 'Extra cost', 'Date']);
  styleHeaderRow(wsI, wsI.rowCount, 6);
  for (const r of inv.replacements || []) {
    const row = wsI.addRow([r.sku, r.title, r.original_sale_id, r.bad_unit_status, moneyCell(Number(r.extra_cost_cents || 0)), excelDate(String(r.date || ''))]);
    row.getCell(5).numFmt = MONEY_FMT;
  }
  wsI.addRow([]);
  wsI.addRow(['Returns']).font = { bold: true };
  wsI.addRow(['SKU', 'Order', 'Channel', 'Refund', 'Label', 'Status', 'Disposition']);
  styleHeaderRow(wsI, wsI.rowCount, 7);
  for (const r of inv.returns || []) {
    const row = wsI.addRow([r.sku, r.order_id, r.channel, moneyCell(Number(r.refund_cents || 0)), moneyCell(Number(r.label_cents || 0)), r.status, r.disposition || r.route_to]);
    row.getCell(4).numFmt = MONEY_FMT;
    row.getCell(5).numFmt = MONEY_FMT;
  }
  setColumnWidths(wsI, [36, 10, 24, 12, 14, 12, 14]);
  setupPrint(wsI, 5);

  const wsP = x.addWorksheet('Payouts');
  addReportTitle(wsP, 'Payouts', periodLabel, generated, 5);
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
  const bankTot = wsP.addRow([
    'Total',
    '',
    moneyCell(p.stores.reduce((n, s) => n + s.money_in_cents, 0)),
    moneyCell(p.stores.reduce((n, s) => n + s.paid_to_bank_cents, 0)),
    '',
  ]);
  bankTot.font = { bold: true };
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
  setColumnWidths(wsP, [28, 16, 16, 16, 16]);
  setupPrint(wsP, hP);

  const wsR = x.addWorksheet('Received');
  const recHeader = ['Date received', 'SKU', 'Item', 'Brand', 'Category', 'Condition', 'Qty', 'Cost', 'Floor price', 'Location', 'Received by', 'Current status'];
  addReportTitle(wsR, 'Items received', periodLabel, generated, recHeader.length);
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
  for (let r = rStart; r <= wsR.rowCount; r++) {
    wsR.getRow(r).getCell(1).numFmt = 'mmm d, yyyy';
    wsR.getRow(r).getCell(8).numFmt = MONEY_FMT;
    wsR.getRow(r).getCell(9).numFmt = MONEY_FMT;
  }
  setColumnWidths(wsR, [14, 9, 30, 14, 16, 12, 6, 10, 10, 14, 14, 16]);
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
