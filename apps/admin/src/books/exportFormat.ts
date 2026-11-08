import type { Worksheet } from 'exceljs';

export const MONEY_FMT = '$#,##0.00;[Red]($#,##0.00)';
export const DATE_FMT = 'mmm d, yyyy';

export function moneyCell(cents: number | null | undefined) {
  if (cents == null || !Number.isFinite(cents)) return null;
  return cents / 100;
}

export function formatPeriodTitle(periodStart: string) {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${periodStart}T12:00:00Z`));
}

export function excelDate(iso: string) {
  const d = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day, 12));
}

export function addReportTitle(
  ws: Worksheet,
  sheetName: string,
  periodLabel: string,
  generated: Date,
  colCount: number,
) {
  const title = `Open Box Industries — ${sheetName} — ${periodLabel}`;
  ws.addRow([title]);
  ws.mergeCells(1, 1, 1, colCount);
  const t1 = ws.getCell(1, 1);
  t1.font = { bold: true, size: 13 };
  t1.alignment = { wrapText: true, vertical: 'middle', horizontal: 'left' };
  ws.getRow(1).height = 22;
  const gen = ws.addRow([`Generated ${generated.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`]);
  ws.mergeCells(2, 1, 2, colCount);
  gen.getCell(1).alignment = { wrapText: true, vertical: 'middle', horizontal: 'left' };
  ws.addRow([]);
}

export function styleHeaderRow(ws: Worksheet, rowNum: number, colCount: number) {
  const row = ws.getRow(rowNum);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.alignment = { vertical: 'middle', wrapText: true };
  row.height = 36;
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F3E54' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF1A2230' } } };
  }
}

/** Default view — no frozen panes (Excel wheel scroll breaks with programatic freeze). */
export function setNormalSheetView(ws: Worksheet) {
  ws.views = [{ state: 'normal', zoomScale: 100, activeCell: 'A1', showGridLines: true }];
}

export function setColumnWidths(ws: Worksheet, widths: number[]) {
  widths.forEach((w, i) => {
    const col = ws.getColumn(i + 1);
    col.width = w;
    col.alignment = { wrapText: true, vertical: 'top' };
  });
}

/** Estimate wrapped line count for Excel column width (approximate character units). */
function wrappedLines(text: string, colWidth: number) {
  const t = String(text || '').trim();
  if (!t) return 1;
  const charsPerLine = Math.max(6, Math.floor(colWidth * 1.05));
  const words = t.split(/\s+/);
  let lines = 1;
  let lineLen = 0;
  for (const word of words) {
    const wlen = word.length;
    if (wlen > charsPerLine) {
      lines += Math.ceil(wlen / charsPerLine);
      lineLen = 0;
      continue;
    }
    if (lineLen === 0) lineLen = wlen;
    else if (lineLen + 1 + wlen <= charsPerLine) lineLen += 1 + wlen;
    else {
      lines += 1;
      lineLen = wlen;
    }
  }
  return Math.max(1, lines);
}

export function wrapDataRows(ws: Worksheet, from: number, to: number, colCount: number) {
  for (let r = from; r <= to; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= colCount; c++) {
      const cell = row.getCell(c);
      if (cell.value == null || cell.value === '') continue;
      cell.alignment = { ...(cell.alignment || {}), wrapText: true, vertical: 'top' };
    }
  }
}

export function fitTitleRows(ws: Worksheet, colCount: number, colWidths: number[]) {
  const mergedWidth = colWidths.slice(0, colCount).reduce((a, b) => a + b, 0);
  for (const rowNum of [1, 2]) {
    const row = ws.getRow(rowNum);
    if (!row.getCell(1).text) continue;
    row.getCell(1).alignment = { wrapText: true, vertical: 'middle', horizontal: 'left' };
    const lines = wrappedLines(String(row.getCell(1).text), mergedWidth);
    row.height = Math.min(72, Math.max(18, 14 * lines + 4));
  }
}

export function mergeLabelRow(ws: Worksheet, rowNum: number, fromCol: number, toCol: number, text: string) {
  if (toCol > fromCol) ws.mergeCells(rowNum, fromCol, rowNum, toCol);
  const cell = ws.getCell(rowNum, fromCol);
  cell.value = text;
  cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'left' };
}

export function fitWrappedRowHeights(ws: Worksheet, from: number, to: number, colWidths: number[]) {
  for (let r = from; r <= to; r++) {
    const row = ws.getRow(r);
    let lines = 1;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const w = colWidths[col - 1] || 12;
      lines = Math.max(lines, wrappedLines(String(cell.text || ''), w));
    });
    row.height = Math.min(120, Math.max(15, 14 * lines + (lines > 1 ? 2 : 0)));
  }
}

export function bandRows(ws: Worksheet, from: number, to: number) {
  for (let r = from; r <= to; r++) {
    if ((r - from) % 2 === 1) {
      ws.getRow(r).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FC' } };
    }
  }
}

export function applyMoney(cells: { getCell: (n: number) => { numFmt?: string; value?: unknown } }[], cols: number[]) {
  for (const row of cells) {
    for (const c of cols) {
      const cell = row.getCell(c);
      if (cell.value != null && cell.value !== '') cell.numFmt = MONEY_FMT;
    }
  }
}

export function setupPrint(ws: Worksheet, headerRow: number) {
  ws.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    showGridLines: false,
    printTitlesRow: `${headerRow}:${headerRow}`,
  };
}

export function displayPaidBy(raw: string) {
  const s = String(raw || '').trim();
  if (!s || s === 'manual_label' || s === 'label') return 'Store';
  if (/^[0-9a-f-]{36}$/i.test(s)) return 'Store';
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function cleanSkuOrder(raw: string) {
  const s = String(raw || '').trim();
  if (!s || /^[0-9a-f-]{36}$/i.test(s)) return '';
  if (/^(manual_label|label|fee|return)$/i.test(s)) return '';
  return s;
}
