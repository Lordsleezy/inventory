import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { CdtfaPrintModel } from './cdtfaLoad';

function money(n: number) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}.00`;
}

export async function addCdtfaExcelSheet(bytes: Uint8Array, model: CdtfaPrintModel): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const name = 'Sales tax';
  const existing = book.getWorksheet(name);
  if (existing) book.removeWorksheet(existing.id);
  const sheet = book.addWorksheet(name);
  sheet.addRow([model.open ? 'DRAFT — PERIOD OPEN' : 'CDTFA-401-A', model.periodLabel]);
  sheet.addRow(['Period', model.periodStart, model.periodEnd, 'Due', model.dueOn]);
  sheet.addRow(['Line', 'Label', 'Amount', 'Floor calculated', 'Edited']);
  for (const line of model.lines) {
    sheet.addRow([line.id, line.label, line.dollars, line.floor, line.edited ? 'yes' : '']);
  }
  sheet.addRow(['A1', 'Transactions subject to tax', model.lines.find((line) => line.id === '12')?.dollars ?? 0]);
  sheet.addRow(['A2/A3', 'Subject only to 7.25%', (model.lines.find((line) => line.id === '12')?.dollars ?? 0) - model.districtMeasure]);
  sheet.addRow(['A4', 'Subject to district tax', model.districtMeasure]);
  sheet.addRow(['Account', model.signer.account]);
  sheet.addRow(['Name', model.signer.name, 'Title', model.signer.title, 'Date', model.signer.date]);
  sheet.addRow(['Email', model.signer.email, 'Phone', model.signer.phone, 'Preparer', 'Floor']);
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
    page.drawText(text.slice(0, 90), { x: 36, y, size: 9, font: strong ? bold : font, color: rgb(0, 0, 0) });
    y -= 12;
  };
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
  write(`Signed ${model.signer.name}  ${model.signer.title}  ${model.signer.date}`);
  write(`Email ${model.signer.email}  Phone ${model.signer.phone}  Preparer Floor`);
  return pdf.save();
}
