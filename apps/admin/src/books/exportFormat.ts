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
  tieWarning?: string,
) {
  const title = `Open Box Industries — ${sheetName} — ${periodLabel}`;
  ws.addRow([title]);
  ws.mergeCells(1, 1, 1, colCount);
  const t1 = ws.getCell(1, 1);
  t1.font = { bold: true, size: 13 };
  t1.alignment = { wrapText: false, vertical: 'middle' };
  ws.getRow(1).height = 20;
  ws.addRow([`Generated ${generated.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`]);
  ws.mergeCells(2, 1, 2, colCount);
  if (tieWarning) {
    const w = ws.addRow([`These numbers don't tie: ${tieWarning}`]);
    ws.mergeCells(w.number, 1, w.number, colCount);
    w.getCell(1).alignment = { wrapText: true, vertical: 'top' };
    w.font = { bold: true, color: { argb: 'FFFF9F0A' } };
    w.height = Math.min(120, 15 + tieWarning.length / 8);
  }
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
  ws.views = [{ state: 'frozen', ySplit: rowNum, xSplit: 1, activeCell: `B${rowNum + 1}` }];
}

export function setColumnWidths(ws: Worksheet, widths: number[]) {
  widths.forEach((w, i) => {
    const col = ws.getColumn(i + 1);
    col.width = w;
    col.alignment = { wrapText: w >= 24, vertical: 'top' };
  });
}

export function fitWrappedRowHeights(ws: Worksheet, from: number, to: number, colWidths: number[]) {
  for (let r = from; r <= to; r++) {
    const row = ws.getRow(r);
    let lines = 1;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const w = colWidths[col - 1] || 12;
      const text = String(cell.text || '');
      const est = Math.ceil(text.length / Math.max(8, w * 0.9)) || 1;
      lines = Math.max(lines, est);
    });
    row.height = Math.min(72, Math.max(15, 15 * lines));
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
