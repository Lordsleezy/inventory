import ExcelJS from 'exceljs';

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value === 'object' && 'text' in value) return String(value.text ?? '');
  if (typeof value === 'object' && 'result' in value) return cellText(value.result as ExcelJS.CellValue);
  if (value instanceof Date) return value.toLocaleDateString('en-CA');
  return String(value);
}

/** Read-only page of the same workbook bytes the download uses. */
export async function spreadsheetHtml(bytes: Uint8Array, fileName: string) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const sheets = book.worksheets.map((sheet, index) => {
    const rows = sheet.getSheetValues().slice(1).map((row) => (Array.isArray(row) ? row.slice(1) : []));
    const body = rows.map((row, rowIndex) => {
      const cells = row.map((value) => {
        const text = cellText(value as ExcelJS.CellValue);
        const numeric = text !== '' && !Number.isNaN(Number(text.replace(/[$,]/g, '')));
        return `<td class="${numeric ? 'num' : ''}${rowIndex === 0 ? ' head' : ''}">${escapeHtml(text)}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<section id="sheet-${index}"><table>${body}</table></section>`;
  }).join('');
  const tabs = book.worksheets.map((sheet, index) => `<a href="#sheet-${index}">${escapeHtml(sheet.name)}</a>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(fileName)}</title>
<style>
  body{margin:0;background:#000;color:#fff;font:14px/1.4 -apple-system,BlinkMacSystemFont,sans-serif}
  header{display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid #2a2a2a;position:sticky;top:0;background:#000}
  nav{display:flex;gap:8px;overflow:auto}
  a{color:#fff}
  table{border-collapse:collapse;width:max-content;min-width:100%}
  td{border-bottom:1px solid #2a2a2a;padding:8px 10px;white-space:nowrap}
  td.head{position:sticky;top:49px;background:#111;font-weight:650}
  td:first-child{position:sticky;left:0;background:#000}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  @media print { header a { display:none } body{background:#fff;color:#000} td{border-color:#ccc} }
</style></head><body>
<header><strong>${escapeHtml(fileName)}</strong><nav>${tabs}</nav><a id="download" href="#">Download .xlsx</a></header>
${sheets || '<p>No sales this month</p>'}
</body></html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] || ch));
}

export async function showSpreadsheet(popup: Window | null, bytes: Uint8Array, fileName: string) {
  const html = await spreadsheetHtml(bytes, fileName);
  const target = popup && !popup.closed ? popup : window.open('', '_blank');
  if (!target) {
    window.location.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    return;
  }
  target.document.open();
  target.document.write(html);
  target.document.close();
  const link = target.document.getElementById('download');
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  if (link) {
    link.setAttribute('href', url);
    link.setAttribute('download', fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`);
  }
}
