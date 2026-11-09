import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { CdtfaPrintModel } from './cdtfaLoad';

function money(n: number) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}.00`;
}

export const CDTFA_SHEET_NAME = 'Sales tax return';

const FORM_BLOCKS: [string, string[]][] = [
  ['Sales', ['1', '2', '3']],
  ['Section A', ['4', '5', '6', '7', '8', '9', '10', 'A11']],
  ['Section B', ['B1', 'B2', 'B3', 'B4', 'B5']],
  ['Tax', ['11', '12', '13', '14', '15', '16', '17', '18', '19']],
  ['Credits and totals', ['20a', '20b', '20c', '20d', '20e', '21', '22', '23', '24', '25', '26', '27', '28']],
];

/** Official filled-PDF file name for a month, quarter, or year. */
export function cdtfaPdfFileName(periodStart: string, periodEnd: string) {
  const startMonth = periodStart.slice(0, 7);
  const endMonth = periodEnd.slice(0, 7);
  if (startMonth === endMonth) return `CDTFA-401-A-${startMonth}.pdf`;
  const start = Number(periodStart.slice(5, 7));
  const end = Number(periodEnd.slice(5, 7));
  if (end - start === 2) return `CDTFA-401-A-${periodStart.slice(0, 4)}-Q${Math.floor((start - 1) / 3) + 1}.pdf`;
  if (periodStart.slice(5) === '01-01' && periodEnd.slice(5) === '12-31') return `CDTFA-401-A-${periodStart.slice(0, 4)}.pdf`;
  return `CDTFA-401-A-${periodStart}-to-${periodEnd}.pdf`;
}

export function fillCdtfaSheet(sheet: ExcelJS.Worksheet, model: CdtfaPrintModel) {
  sheet.addRow(['CDTFA-401-A REV. 126 (1-26)']);
  if (model.recordsNote) sheet.addRow([model.recordsNote]);
  if (model.optionTitle) sheet.addRow([model.optionTitle]);
  if (model.optionHint) sheet.addRow([model.optionHint]);
  if (model.open) sheet.addRow(['DRAFT — PERIOD OPEN']);
  sheet.addRow(['Period start', model.periodStart, 'Period end', model.periodEnd, 'Due', model.dueOn, model.periodLabel]);
  sheet.addRow(['Line', 'Label', 'Amount', 'Floor calculated', 'Edited']);
  const byId = new Map(model.lines.map((line) => [line.id, line]));
  const used = new Set<string>();
  for (const [title, ids] of FORM_BLOCKS) {
    const rows = ids.map((id) => byId.get(id)).filter((line): line is CdtfaPrintModel['lines'][number] => !!line);
    if (!rows.length) continue;
    sheet.addRow([title]);
    for (const line of rows) {
      used.add(line.id);
      sheet.addRow([line.id, line.label, line.dollars, line.floor, line.edited ? 'yes' : '']);
    }
  }
  for (const line of model.lines) {
    if (used.has(line.id)) continue;
    sheet.addRow([line.id, line.label, line.dollars, line.floor, line.edited ? 'yes' : '']);
  }
  const taxable = byId.get('12')?.dollars ?? 0;
  sheet.addRow(['Schedule A2']);
  if (model.scheduleNote) sheet.addRow([model.scheduleNote]);
  sheet.addRow(['A1', 'Transactions subject to tax', taxable]);
  sheet.addRow(['A2/A3', 'Subject only to 7.25%', taxable - model.districtMeasure]);
  sheet.addRow(['A4', 'Subject to district tax', model.districtMeasure, '', model.districtMeasureEdited ? 'yes' : '']);
  sheet.addRow(['Account', model.signer.account]);
  sheet.addRow(['Name', model.signer.name, 'Title', model.signer.title, 'Date', model.signer.date]);
  sheet.addRow(['Email', model.signer.email, 'Phone', model.signer.phone, 'Preparer', 'Floor']);
  if (model.roundingNote) sheet.addRow([model.roundingNote]);
}

export async function addCdtfaExcelSheet(bytes: Uint8Array, model: CdtfaPrintModel): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const existing = book.getWorksheet(CDTFA_SHEET_NAME) || book.getWorksheet('Sales tax');
  if (existing) book.removeWorksheet(existing.id);
  fillCdtfaSheet(book.addWorksheet(CDTFA_SHEET_NAME), model);
  const out = await book.xlsx.writeBuffer();
  return new Uint8Array(out);
}

export async function addCdtfaPdfPages(bytes: Uint8Array, model: CdtfaPrintModel): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 612;
  const pageHeight = 792;
  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - 36;
  const write = (text: string, strong = false) => {
    if (y < 36) {
      page = pdf.addPage([pageWidth, pageHeight]);
      y = pageHeight - 36;
    }
    page.drawText(text.replace(/—/g, '-').slice(0, 110), { x: 36, y, size: 9, font: strong ? bold : font, color: rgb(0, 0, 0) });
    y -= 12;
  };
  if (model.optionTitle) write(model.optionTitle, true);
  if (model.optionHint) write(model.optionHint);
  if (model.recordsNote) write(model.recordsNote, true);
  if (model.open) write('DRAFT — PERIOD OPEN', true);
  write('CDTFA-401-A REV. 126 (1-26)', true);
  write(model.periodLabel, true);
  write(`Period ${model.periodStart} to ${model.periodEnd} · Due ${model.dueOn}`);
  write(`Account ${model.signer.account || ''}`);
  for (const line of model.lines) write(`${line.id.padEnd(4, ' ')} ${line.label.slice(0, 48).padEnd(48, ' ')} ${money(line.dollars)}${line.edited ? '  edited' : ''}`);
  const taxable = model.lines.find((line) => line.id === '12')?.dollars ?? 0;
  write(`A1  Transactions subject to tax          ${money(taxable)}`);
  write(`A2/A3 Subject only to 7.25%              ${money(taxable - model.districtMeasure)}`);
  write(`A4  Subject to district tax              ${money(model.districtMeasure)}`);
  if (model.roundingNote) write(model.roundingNote);
  write(`Signed ${model.signer.name}  ${model.signer.title}  ${model.signer.date}`);
  write(`Email ${model.signer.email}  Phone ${model.signer.phone}  Preparer Floor`);
  return pdf.save();
}
