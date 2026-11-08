import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { monthLabel } from './booksMath';
import type { BooksWorkbook, Period } from './types';

function moneyCell(cents: number | null | undefined) {
  if (cents == null || Number.isNaN(cents)) return '';
  return cents / 100;
}

function pdfText(value: unknown) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E\n\r\t]/g, '?');
}

export async function buildBooksExcel(period: Period, wb: BooksWorkbook, label: string) {
  const x = new ExcelJS.Workbook();
  x.creator = 'Floor Books';
  x.subject = label;

  const moneyFmt = '$#,##0.00;[Red]-$#,##0.00';
  const header = (ws: ExcelJS.Worksheet, cols: string[]) => {
    ws.addRow(cols);
    const h = ws.lastRow!;
    h.font = { bold: true };
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF253348' } };
    h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    return h.number;
  };

  const wsE = x.addWorksheet('Expenses');
  header(wsE, ['Date', 'Category', 'Description', 'Amount', 'SKU / order', 'Paid by', 'Reimburse?', 'Source']);
  for (const r of wb.expenses.rows) {
    const row = wsE.addRow([r.date, r.category, r.description, moneyCell(r.amount_cents), r.sku_or_order, r.paid_by, r.needs_reimbursement, r.source]);
    row.getCell(4).numFmt = moneyFmt;
  }
  wsE.addRow([]);
  for (const c of wb.expenses.categoryTotals) {
    const row = wsE.addRow([`${c.category} subtotal`, '', '', moneyCell(c.amount_cents)]);
    row.getCell(4).numFmt = moneyFmt; row.font = { bold: true };
  }
  const gt = wsE.addRow(['Grand total', '', '', moneyCell(wb.expenses.total_cents)]);
  gt.getCell(4).numFmt = moneyFmt; gt.font = { bold: true };

  const wsS = x.addWorksheet('Sales');
  header(wsS, ['Date', 'SKU', 'Title', 'Channel', 'Order #', 'Qty', 'Price', 'Tax', 'Marketplace fees', 'Card fees', 'Buyer shipping', 'Label cost', 'COGS', 'Profit', 'Commission', 'Notes']);
  for (const r of wb.sales.rows) {
    const row = wsS.addRow([r.date, r.sku, r.title, r.channel, r.order_no, r.qty, moneyCell(r.price_cents), moneyCell(r.tax_cents), moneyCell(r.marketplace_fees_cents), moneyCell(r.card_fees_cents), moneyCell(r.buyer_shipping_cents), moneyCell(r.label_cost_cents), moneyCell(r.cost_cents), moneyCell(r.profit_cents), moneyCell(r.commission_cents), r.profit_notes]);
    for (const col of [7, 8, 9, 10, 11, 12, 13, 14, 15]) row.getCell(col).numFmt = moneyFmt;
  }
  wsS.addRow([]);
  for (const c of wb.sales.channelTotals) {
    const row = wsS.addRow([`${c.channel} subtotal`, '', '', '', '', c.count, moneyCell(c.revenue_cents), '', '', '', '', '', '', moneyCell(c.profit_cents)]);
    row.getCell(7).numFmt = moneyFmt; row.getCell(14).numFmt = moneyFmt;
  }
  const t = wb.sales.totals;
  const tot = wsS.addRow(['Period totals', '', '', '', '', '', moneyCell(t.revenue), '', '', '', '', moneyCell(t.labelCostsOnSales), moneyCell(t.cost), moneyCell(t.profit), moneyCell(t.commission)]);
  for (const col of [7, 12, 13, 14, 15]) tot.getCell(col).numFmt = moneyFmt;
  tot.font = { bold: true };

  const wsI = x.addWorksheet('Inventory');
  wsI.addRow(['Metric', 'Units', 'Source']);
  const inv = wb.inventory;
  for (const [metric, value, src] of [
    ['Start of month', inv.start_unit_count, inv.start_source],
    ['End of month', inv.end_unit_count, inv.end_source],
    ['Sold', inv.sold_units, 'sales'],
    ['Received', inv.received_units, 'movements'],
    ['Giveaways', inv.giveaway_units, 'dispositions'],
    ['Replacements', inv.replacement_units, 'dispositions'],
    ['Returns (count)', inv.return_count, 'returns'],
    ['Defective pulls', inv.defective_units, 'stock_movements'],
  ] as const) wsI.addRow([metric, value, src]);
  wsI.addRow([]);
  header(wsI, ['Giveaways', 'SKU', 'Title', 'Cost', 'Given to', 'Date']);
  for (const g of inv.giveaways || []) {
    const row = wsI.addRow(['', g.sku, g.title, moneyCell(Number(g.cost_cents)), g.given_to, String(g.date || '').slice(0, 10)]);
    row.getCell(4).numFmt = moneyFmt;
  }
  wsI.addRow([]);
  header(wsI, ['Replacements', 'SKU', 'Title', 'Original sale', 'Bad unit', 'Extra cost', 'Date']);
  for (const r of inv.replacements || []) {
    const row = wsI.addRow(['', r.sku, r.title, r.original_sale_id, r.bad_unit_status, moneyCell(Number(r.extra_cost_cents || 0)), String(r.date || '').slice(0, 10)]);
    row.getCell(6).numFmt = moneyFmt;
  }
  wsI.addRow([]);
  header(wsI, ['Returns', 'SKU', 'Order', 'Channel', 'Refund', 'Label', 'Status', 'Disposition']);
  for (const r of inv.returns || []) {
    const row = wsI.addRow(['', r.sku, r.order_id, r.channel, moneyCell(Number(r.refund_cents || 0)), moneyCell(Number(r.label_cents || 0)), r.status, r.disposition || r.route_to]);
    row.getCell(5).numFmt = moneyFmt; row.getCell(6).numFmt = moneyFmt;
  }

  const wsR = x.addWorksheet('Received');
  header(wsR, ['Received', 'SKU', 'Title', 'Brand', 'Category', 'Condition', 'Qty', 'Cost', 'Floor price', 'Location', 'Receiver', 'Listing / status']);
  for (const r of wb.received) {
    const row = wsR.addRow([String(r.received_at || '').slice(0, 10), r.sku, r.title, r.brand, r.category, r.condition, r.qty_on_hand, moneyCell(Number(r.cost_cents)), moneyCell(Number(r.ask_cents)), r.location, r.receiver_name, r.listing_status]);
    row.getCell(8).numFmt = moneyFmt; row.getCell(9).numFmt = moneyFmt;
  }

  wsE.addRow(['Period', `${period.period_start} – ${period.period_end}`]);
  wsS.addRow(['Period', `${period.period_start} – ${period.period_end}`]);
  return x.xlsx.writeBuffer();
}

export async function buildBooksPdf(period: Period, wb: BooksWorkbook, money: (c: number) => string) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 792; const pageHeight = 612; const margin = 34;
  let page = pdf.addPage([pageWidth, pageHeight]); let y = pageHeight - margin;
  const title = monthLabel(period.period_start);
  const newPage = (section: string) => { page = pdf.addPage([pageWidth, pageHeight]); y = pageHeight - margin; page.drawText(section, { x: margin, y, size: 12, font: bold }); y -= 18; };
  const line = (text: string, strong = false) => {
    const f = strong ? bold : font;
    if (y < margin + 14) newPage('(continued)');
    page.drawText(pdfText(text).slice(0, 140), { x: margin, y, size: 8, font: f, color: rgb(0.1, 0.13, 0.18) });
    y -= 11;
  };

  page.drawText('Open Box Industries · Books', { x: margin, y, size: 16, font: bold }); y -= 20;
  page.drawText(`${title} · ${period.period_start} to ${period.period_end}`, { x: margin, y, size: 10, font }); y -= 16;
  const t = wb.sales.totals;
  line(`Sales ${money(t.revenue)} · COGS ${money(t.cost)} · Fees+labels ${money(t.feesAndLabels)} · Commission ${money(t.commission)} · Profit ${money(t.profit)}`, true);

  newPage('Expenses');
  for (const r of wb.expenses.rows.slice(0, 80)) line(`${r.date} · ${r.category} · ${r.description} · ${money(r.amount_cents)}`);
  line(`Grand total ${money(wb.expenses.total_cents)}`, true);

  newPage('Sales');
  for (const r of wb.sales.rows.slice(0, 100)) line(`${r.date} · ${r.sku} · ${r.channel} · ${money(r.price_cents)} · profit ${r.profit_cents == null ? '—' : money(r.profit_cents)}${r.profit_notes ? ` · ${r.profit_notes}` : ''}`);

  newPage('Inventory summary');
  line(`Start ${invMetric(wb.inventory.start_unit_count)} (${wb.inventory.start_source}) · End ${invMetric(wb.inventory.end_unit_count)} (${wb.inventory.end_source})`);
  line(`Sold ${wb.inventory.sold_units} · Received ${wb.inventory.received_units} · Giveaways ${wb.inventory.giveaway_units} · Replacements ${wb.inventory.replacement_units} · Returns ${wb.inventory.return_count} · Defective ${wb.inventory.defective_units}`);

  newPage('Items received');
  for (const r of wb.received.slice(0, 100)) line(`${String(r.received_at || '').slice(0, 10)} · ${r.sku} · ${r.title} · qty ${r.qty_on_hand}`);

  const pages = pdf.getPages();
  pages.forEach((p: (typeof pages)[number], i: number) => p.drawText(`Page ${i + 1} of ${pages.length}`, { x: margin, y: 12, size: 8, font }));
  return pdf.save();
}

function invMetric(n: number) { return String(n ?? '—'); }

export function downloadBytes(name: string, data: ArrayBuffer | Uint8Array, type: string) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function bytesBase64(buffer: ArrayBuffer | Uint8Array) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer); let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
