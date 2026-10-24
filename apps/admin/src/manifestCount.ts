/** Count physical items, using a quantity column when the sheet has one. */
export function countManifestRows(rows: unknown[][]): number {
  const nonempty = rows.filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''));
  if (!nonempty.length) return 0;
  const header = nonempty[0].map((cell) => String(cell ?? '').trim().toLowerCase());
  const quantity = header.findIndex((name) => /^(qty|quantity|units|unit count|item count)$/i.test(name));
  const looksLikeHeader = header.some((name) => /^(qty|quantity|units|unit count|item count|sku|upc|item|product|description|model|brand|title)$/i.test(name));
  const data = looksLikeHeader ? nonempty.slice(1) : nonempty;
  if (quantity < 0) return data.length;
  return data.reduce((count, row) => {
    const value = Number(String(row[quantity] ?? '').replace(/,/g, '').trim());
    return count + (Number.isFinite(value) && value > 0 ? Math.floor(value) : 1);
  }, 0);
}

/** Minimal RFC 4180 reader, preserving quoted commas/newlines. */
export function parseManifestCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export async function countManifestFile(file: File): Promise<{ count: number; automatic: boolean }> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'csv') return { count: countManifestRows(parseManifestCsv(await file.text())), automatic: true };
  if (extension === 'xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheet = workbook.worksheets[0];
    if (!sheet) return { count: 0, automatic: true };
    const rows: unknown[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => { rows.push((row.values as unknown[]).slice(1)); });
    return { count: countManifestRows(rows), automatic: true };
  }
  return { count: 0, automatic: false };
}
