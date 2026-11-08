import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

type Line = { id: string; dollars: number };
export type CdtfaPdfDoc = {
  period_start: string;
  period_end: string;
  due_on: string;
  lines: Line[];
  signer?: { name?: string; title?: string; date?: string; email?: string; phone?: string; account?: string };
  /** Schedule A2 line A4. Zero at Penryn. A2/A3 is line 12 minus this. */
  districtMeasure?: number;
  open?: boolean;
  recordsNote?: string | null;
  optionTitle?: string | null;
  optionHint?: string | null;
};

/**
 * REV. 126 names the boxes after line 23 by an older numbering.
 * Printed line 24 (penalty) is field "26". Printed line 26 (total due) is field "30".
 */
export const CDTFA_LINE_FIELDS: Record<string, string> = {
  '1': '1', '2': '2', '3': '3',
  '11': '11', '12': '12', '13': '13', '14': '14', '15': '15', '16': '16',
  '17': '17', '18': '18', '19': '19',
  '20a': '20a', '20b': '20b', '20c': '20c', '20d': '20d', '20e': '20e',
  '21': '21', '22': '22', '23': '23',
  '24': '26',
  '25': '29',
  '26': '30',
  '27': '31',
  '28': '52',
};

/** Page 3 (S2) field names, keyed by the on-screen line id. */
export const CDTFA_PAGE3_FIELDS: Record<string, string> = {
  '4': '32', '5': '33', '6': '34', '7': '35', '8': '36', '9': '37', '10': '38',
  'A11': '39', 'B1': '40', 'B2': '41', 'B3': '42', 'B4': '43', 'B5': '44', '11': '45',
};

const money = (n: number) => String(Math.round(n));

function line(doc: CdtfaPdfDoc, id: string) {
  return doc.lines.find((row) => row.id === id)?.dollars ?? 0;
}

function usDate(iso: string) {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

/** Fill the official CDTFA-401-A (REV. 126) from the same line ids the screen shows. */
export async function fillCdtfaPdfBytes(bytes: ArrayBuffer | Uint8Array, doc: CdtfaPdfDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes);
  const form = pdf.getForm();
  const set = (name: string, value: string) => {
    form.getTextField(name).setText(value);
  };
  set('Due', usDate(doc.due_on));
  set('Due on or Before 2', usDate(doc.due_on));
  set('Period Begin', usDate(doc.period_start));
  set('Period End', usDate(doc.period_end));
  set('ReportingPeriod', `${usDate(doc.period_start)} - ${usDate(doc.period_end)}`);
  for (const [id, field] of Object.entries(CDTFA_LINE_FIELDS)) set(field, money(line(doc, id)));
  set('22a', '0');
  set('22b', '0');
  for (const [id, field] of Object.entries(CDTFA_PAGE3_FIELDS)) set(field, money(line(doc, id)));
  const taxable = line(doc, '12');
  const district = Math.round(doc.districtMeasure ?? 0);
  set('A2', money(taxable));
  set('A2-A4', money(taxable - district));
  set('A5', money(district));
  set('38a', 'Marketplace facilitator sales (eBay, TikTok Shop, Amazon, Depop, Mercari)');
  set('PaidName', 'Floor');
  const signer = doc.signer || {};
  const optional: [string, string][] = [
    ['Print Name', signer.name || ''],
    ['Date', signer.date || ''],
    ['Emailadd', signer.email || ''],
    ['Telephone', signer.phone || ''],
    ['AccountNumber', signer.account || ''],
  ];
  for (const [name, value] of optional) {
    try { if (value) form.getTextField(name).setText(value); } catch { /* leave a field blank if this revision renamed it */ }
  }
  try { form.updateFieldAppearances(); } catch { /* the official form keeps its own font */ }
  const notes = [doc.recordsNote, doc.optionTitle, doc.optionHint].filter((note): note is string => !!note);
  if (notes.length || doc.open) {
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const page = pdf.getPage(0);
    let y = page.getHeight() - 18;
    for (const note of notes) {
      page.drawText(note.replace(/—/g, '-'), { x: 28, y, size: 8, font, color: rgb(0, 0, 0) });
      y -= 11;
    }
    if (doc.open) page.drawText('DRAFT - PERIOD OPEN', { x: 28, y, size: 8, font, color: rgb(0, 0, 0) });
  }
  return pdf.save();
}

let template: Promise<ArrayBuffer> | null = null;

export function loadCdtfaTemplate() {
  template ||= fetch('/cdtfa/cdtfa401a.pdf').then((res) => {
    if (!res.ok) throw new Error('The official CDTFA form could not be loaded.');
    return res.arrayBuffer();
  });
  return template;
}

export async function fillCdtfaPdf(doc: CdtfaPdfDoc): Promise<Uint8Array> {
  return fillCdtfaPdfBytes(await loadCdtfaTemplate(), doc);
}

/** The official PDF is filled from the same numbers the on-screen form is showing. */
export function paperToCdtfaDoc(model: {
  periodStart: string; periodEnd: string; dueOn: string;
  lines: { id: string; dollars: number }[];
  signer?: CdtfaPdfDoc['signer'];
  districtMeasure?: number;
  open?: boolean;
  recordsNote?: string | null;
  optionTitle?: string | null;
  optionHint?: string | null;
}): CdtfaPdfDoc {
  return {
    period_start: model.periodStart,
    period_end: model.periodEnd,
    due_on: model.dueOn,
    lines: model.lines.map((line) => ({ id: line.id, dollars: line.dollars })),
    signer: model.signer,
    districtMeasure: model.districtMeasure ?? 0,
    open: model.open,
    recordsNote: model.recordsNote,
    optionTitle: model.optionTitle,
    optionHint: model.optionHint,
  };
}
