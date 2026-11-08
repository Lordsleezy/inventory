import { spanBounds, spanTitle } from './booksSpan.ts';
import type { Period } from './types.ts';

export type ArchiveItem = {
  kind: 'month' | 'quarter';
  title: string;
  start: string;
  end: string;
  months: Period[];
};

/** Months with a Books period, then the quarter those months belong to. */
export function archivePlan(periods: Period[]): ArchiveItem[] {
  const months = periods
    .filter((period) => period.period_type === 'month')
    .slice()
    .sort((a, b) => a.period_start.localeCompare(b.period_start));
  const groups = new Map<string, Period[]>();
  for (const month of months) {
    const start = spanBounds(month.period_start, 'quarter').start;
    const list = groups.get(start) || [];
    list.push(month);
    groups.set(start, list);
  }
  const items: ArchiveItem[] = [];
  for (const [start, group] of groups) {
    const bounds = spanBounds(start, 'quarter');
    for (const month of group) {
      items.push({
        kind: 'month',
        title: spanTitle(month.period_start, 'month'),
        start: month.period_start,
        end: month.period_end,
        months: [month],
      });
    }
    items.push({
      kind: 'quarter',
      title: spanTitle(start, 'quarter'),
      start: bounds.start,
      end: bounds.end,
      months: group,
    });
  }
  return items;
}

function crc32(data: Uint8Array) {
  let crc = ~0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** Uncompressed zip. The PDFs and the workbook are already compressed inside. */
export function zipStore(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const encoder = new TextEncoder();
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.bytes);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, file.bytes.length, true);
    view.setUint32(22, file.bytes.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, file.bytes);
    const dir = new Uint8Array(46 + name.length);
    const dirView = new DataView(dir.buffer);
    dirView.setUint32(0, 0x02014b50, true);
    dirView.setUint16(4, 20, true);
    dirView.setUint16(6, 20, true);
    dirView.setUint16(8, 0x0800, true);
    dirView.setUint16(10, 0, true);
    dirView.setUint16(12, 0, true);
    dirView.setUint16(14, 0, true);
    dirView.setUint32(16, crc, true);
    dirView.setUint32(20, file.bytes.length, true);
    dirView.setUint32(24, file.bytes.length, true);
    dirView.setUint16(28, name.length, true);
    dirView.setUint16(30, 0, true);
    dirView.setUint16(32, 0, true);
    dirView.setUint16(34, 0, true);
    dirView.setUint16(36, 0, true);
    dirView.setUint32(38, 0, true);
    dirView.setUint32(42, offset, true);
    dir.set(name, 46);
    central.push(dir);
    offset += local.length + file.bytes.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);
  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
