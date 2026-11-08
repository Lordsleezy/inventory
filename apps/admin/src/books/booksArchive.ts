import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import type { CdtfaPrintModel } from './cdtfaLoad';
import type { BooksWorkbook } from './types';

export { archivePlan, zipStore, type ArchiveItem } from './booksArchivePure';

export function periodHasActivity(workbook: BooksWorkbook, lines: { id: string; dollars: number }[]) {
  const dollars = (id: string) => lines.find((line) => line.id === id)?.dollars ?? 0;
  return dollars('1') !== 0
    || dollars('B3') !== 0
    || workbook.sales.totals.revenue !== 0
    || workbook.sales.totals.expense !== 0
    || workbook.received.length > 0;
}

export function addArchiveSheet(book: ExcelJS.Workbook, title: string, workbook: BooksWorkbook, tax: CdtfaPrintModel) {
  const sheet = book.addWorksheet(title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  const totals = workbook.sales.totals;
  const dollars = (cents: number) => Math.round(cents) / 100;
  if (tax.optionTitle) sheet.addRow([tax.optionTitle]);
  if (tax.optionHint) sheet.addRow([tax.optionHint]);
  if (tax.recordsNote) sheet.addRow([tax.recordsNote]);
  sheet.addRow([tax.open ? 'DRAFT — PERIOD OPEN' : 'Period closed']);
  sheet.addRow(['Period', title, tax.periodStart, tax.periodEnd, 'Due', tax.dueOn]);
  sheet.addRow(['Sales', dollars(totals.revenue)]);
  sheet.addRow(['Profit', dollars(totals.profit)]);
  sheet.addRow(['Commissions', dollars(totals.commission)]);
  sheet.addRow(['Expenses', dollars(totals.expense)]);
  sheet.addRow(['Owner keeps', dollars(totals.ownerKeeps)]);
  sheet.addRow([]);
  sheet.addRow(['Line', 'Label', 'Dollars']);
  for (const line of tax.lines) sheet.addRow([line.id, line.label, line.dollars]);
  const taxable = tax.lines.find((line) => line.id === '12')?.dollars ?? 0;
  sheet.addRow(['A1', 'Transactions subject to tax', taxable]);
  sheet.addRow(['A2/A3', 'Subject only to 7.25%', taxable - tax.districtMeasure]);
  sheet.addRow(['A4', 'Subject to district tax', tax.districtMeasure]);
  if (tax.roundingNote) sheet.addRow([tax.roundingNote]);
}

export async function appendPdf(reportPdf: Uint8Array, formPdf: Uint8Array) {
  const report = await PDFDocument.load(reportPdf);
  const form = await PDFDocument.load(formPdf);
  const pages = await report.copyPages(form, form.getPageIndices());
  for (const page of pages) report.addPage(page);
  return report.save();
}

