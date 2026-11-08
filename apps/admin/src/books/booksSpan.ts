import type { CdtfaFrequency } from './cdtfaResolve';

export type BooksSpan = 'month' | 'quarter' | 'year';

export function spanFrequency(span: BooksSpan): CdtfaFrequency {
  if (span === 'month') return 'monthly';
  if (span === 'year') return 'yearly';
  return 'quarterly';
}

export function formKind(start: string, end: string): BooksSpan {
  const startMonth = Number(start.slice(5, 7));
  const endMonth = Number(end.slice(5, 7));
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  if (sameYear && startMonth === 1 && endMonth === 12) return 'year';
  if (sameYear && endMonth - startMonth === 2) return 'quarter';
  return 'month';
}

/** The copy stamped on a form that is not this store's assigned filing schedule. */
export function recordsStamp(kind: BooksSpan, filing: CdtfaFrequency): string | null {
  const assigned = filing === 'monthly' ? 'month' : filing === 'yearly' ? 'year' : 'quarter';
  if (kind === assigned) return null;
  const word = filing === 'monthly' ? 'monthly' : filing === 'yearly' ? 'yearly' : 'quarterly';
  return `FOR RECORDS — DO NOT FILE (this store files ${word})`;
}

export function quarterStart(monthStart: string) {
  const year = Number(monthStart.slice(0, 4));
  const month = Number(monthStart.slice(5, 7));
  const start = Math.floor((month - 1) / 3) * 3 + 1;
  return `${year}-${pad(start)}-01`;
}

export function yearStart(monthStart: string) {
  return `${monthStart.slice(0, 4)}-01-01`;
}

export function spanBounds(anchorMonth: string, span: BooksSpan) {
  const start = span === 'year' ? yearStart(anchorMonth) : span === 'quarter' ? quarterStart(anchorMonth) : `${anchorMonth.slice(0, 7)}-01`;
  const [year, month] = start.split('-').map(Number);
  const last = span === 'year' ? 12 : span === 'quarter' ? month + 2 : month;
  return { start, end: lastDay(year, last) };
}

export function monthsInRange(start: string, end: string) {
  const months: string[] = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));
  const endKey = end.slice(0, 7);
  while (`${year}-${pad(month)}` <= endKey) {
    months.push(`${year}-${pad(month)}-01`);
    month += 1;
    if (month === 13) { month = 1; year += 1; }
  }
  return months;
}

export function spanTitle(start: string, span: BooksSpan) {
  const year = start.slice(0, 4);
  const month = Number(start.slice(5, 7));
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  if (span === 'year') return year;
  if (span === 'quarter') return `Q${Math.floor((month - 1) / 3) + 1} ${year}`;
  return `${names[month - 1]} ${year}`;
}

function pad(n: number) { return String(n).padStart(2, '0'); }
function lastDay(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
