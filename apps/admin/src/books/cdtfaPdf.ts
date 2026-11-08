import { PDFDocument } from 'pdf-lib';

type Line = { id: string; dollars: number };
type ReturnDoc = {
  period_start: string;
  period_end: string;
  due_on: string;
  lines: Line[];
};

const money = (n: number) => String(Math.round(n));

function line(doc: ReturnDoc, id: string) {
  return doc.lines.find((row) => row.id === id)?.dollars ?? 0;
}

function usDate(iso: string) {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

/** Fill the official CDTFA-401-A (REV. 126). Signature and account number stay blank. */
export async function fillCdtfaPdf(doc: ReturnDoc): Promise<Uint8Array> {
  const res = await fetch('/cdtfa/cdtfa401a.pdf');
  if (!res.ok) throw new Error('The official CDTFA form could not be loaded.');
  const pdf = await PDFDocument.load(await res.arrayBuffer());
  const form = pdf.getForm();
  const set = (name: string, value: string) => {
    const field = form.getTextField(name);
    field.setText(value);
  };
  set('Due', usDate(doc.due_on));
  set('Due on or Before 2', usDate(doc.due_on));
  set('Period Begin', usDate(doc.period_start));
  set('Period End', usDate(doc.period_end));
  for (const id of ['1', '2', '3', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20a', '20b', '20c', '20d', '20e', '21', '22', '23', '26']) {
    set(id, money(line(doc, id)));
  }
  const page3: [string, string][] = [
    ['32', '4'], ['33', '5'], ['34', '6'], ['35', '7'], ['36', '8'], ['37', '9'], ['38', '10'],
    ['39', 'A11'], ['40', 'B1'], ['41', 'B2'], ['42', 'B3'], ['43', 'B4'], ['44', 'B5'], ['45', '11'],
  ];
  for (const [field, id] of page3) set(field, money(line(doc, id)));
  set('38a', 'Marketplace facilitator sales (eBay, TikTok Shop, Amazon, Depop, Mercari)');
  set('PaidName', 'Floor');
  try { form.updateFieldAppearances(); } catch { /* the official form keeps its own font */ }
  return pdf.save();
}
