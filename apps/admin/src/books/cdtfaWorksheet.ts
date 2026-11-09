import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export type WorksheetLine = { id: string; label: string; dollars: number; note?: string };

const KEEP = new Set(['1', '10', '11', '12', '13', '14', '15', '16', '17', '23', '24', '25', '26']);

function money(n: number) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
}

/** Floor's one-page worksheet. It is not part of the official CDTFA file. */
export async function buildCdtfaWorksheet(input: {
  periodStart: string;
  periodEnd: string;
  dueOn: string;
  fileOn: string;
  late: boolean;
  lines: WorksheetLine[];
  pageCount: number;
  scheduleIncluded: boolean;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  let y = 752;
  const draw = (text: string, size: number, face = font, x = 48) => {
    if (y < 46) return;
    page.drawText(text, { x, y, size, font: face, color: black });
    y -= size + 3;
  };
  const wrap = (text: string, size = 8) => {
    const words = text.split(/\s+/);
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > 516) {
        draw(line, size);
        line = word;
      } else line = next;
    }
    if (line) draw(line, size);
  };

  draw('Open Box Industries', 16, bold);
  draw('How this CDTFA-401-A was figured', 12, bold);
  wrap(`${input.periodStart} through ${input.periodEnd}. Due ${input.dueOn}. Filing date used for the penalty: ${input.fileOn}.`);
  wrap('Floor adds the lines up. It is not the paid preparer, it does not file this return, and this page is not tax advice.');
  y -= 6;
  draw('The lines', 11, bold);
  const at = (id: string) => input.lines.find((line) => line.id === id);
  for (const line of input.lines) {
    if (!KEEP.has(line.id) && line.dollars === 0) continue;
    wrap(`${line.id}. ${line.label}: ${money(line.dollars)}. ${(line.note || '').slice(0, 160)}`.replace(/\s+/g, ' ').trim());
  }
  y -= 4;
  const twelve = at('12')?.dollars ?? 0;
  const state = at('13')?.dollars ?? 0;
  const county = at('14')?.dollars ?? 0;
  const local = at('15')?.dollars ?? 0;
  const district = at('16')?.dollars ?? 0;
  const total = at('17')?.dollars ?? 0;
  draw('Rounding', 11, bold);
  wrap(`The form says to round cents to the nearest whole dollar. Line 12 is ${money(twelve)}. Line 13 is round(line 12 × 0.06) = ${money(state)}. Line 14 is round(line 12 × 0.0025) = ${money(county)}. Line 15 is round(line 12 × 0.01) = ${money(local)}. Line 16 is ${money(district)}. Line 17 adds those rounded lines: ${money(state)} + ${money(county)} + ${money(local)} + ${money(district)} = ${money(total)}.`);
  y -= 4;
  draw('What was left off', 11, bold);
  const one = at('1')?.dollars ?? 0;
  const ten = at('10')?.dollars ?? 0;
  wrap(`Line 1 is ${money(one)} and line 10 is ${money(ten)}. Marketplace sales (eBay, TikTok Shop, Amazon, Depop, Mercari) stay inside line 1. Line 10 deducts them, because the marketplace collects that tax. A line 10 of $0 means this period had no marketplace deduction. The figures were not changed.`);
  if (input.scheduleIncluded) {
    wrap('Line 16 is over $0, so Schedule A2 is in the official download. Instruction and example pages are not. Blank district pages stay in, because the schedule instructions only say you are finished when line A4 is $0.');
  } else {
    wrap('Line 16 is $0 and Schedule A2 line A4 is $0. The schedule instructions say you are finished with Schedule A2 in that case, so those pages are not in the official download. Instruction and example pages are never included.');
  }
  wrap(`The official download is ${input.pageCount} page${input.pageCount === 1 ? '' : 's'} of CDTFA-401-A REV. 126 (1-26). This worksheet is a separate Floor page.`);
  y -= 4;
  draw('Late filing', 11, bold);
  if (input.late) {
    const net = at('23')?.dollars ?? 0;
    const penalty = at('24')?.dollars ?? 0;
    wrap(`The filing date is after ${input.dueOn}. Line 24 is 10 percent of line 23 (${money(net)}), rounded to ${money(penalty)}. Line 25 interest is blank. Look it up on CDTFA's interest calculation tool at cdtfa.ca.gov/taxes-and-fees/interest-calculation.htm. Floor does not guess the rate. Line 26 does not include interest until you type it.`);
  } else {
    wrap('The filing date is on or before the due date, so line 24 penalty is $0 and line 25 interest is $0.');
  }
  y -= 4;
  draw('Before you send it', 11, bold);
  wrap('Check pages 1 through 3, sign page 2, and confirm the account number is on every account box. File at onlineservices.cdtfa.ca.gov or mail the return. Floor does not send anything to CDTFA.');
  page.drawText('Page 1 of 1', { x: 48, y: 28, size: 8, font, color: black });
  return pdf.save();
}
