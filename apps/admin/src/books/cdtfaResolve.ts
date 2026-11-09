export type CdtfaFrequency = 'monthly' | 'quarterly' | 'yearly';

export type FloorLine = { id: string; label: string; dollars: number; note?: string; sales?: unknown[] };

const DERIVED = new Set(['3', 'A11', 'B5', '11', '12', '13', '14', '15', '17', '19', '20e', '21', '23', '26']);

export function isDerivedLine(id: string) {
  return DERIVED.has(id);
}

function roundDollars(n: number) {
  return Math.round(n);
}

/** Same arithmetic the return uses: edited boxes win, then totals are rebuilt from them. */
export function resolveCdtfaDollars(
  floor: { id: string; dollars: number }[],
  edits: Record<string, number | undefined>,
  _collectedDollars = 0,
  late = false,
): { id: string; dollars: number; floor: number; edited: boolean }[] {
  const floorOf = new Map(floor.map((row) => [row.id, row.dollars]));
  const seen = new Set<string>();
  const value = (id: string): number => {
    if (id === '24') return late ? roundDollars(value('23') * 0.1) : 0;
    if (seen.has(id)) return floorOf.get(id) ?? 0;
    if (edits[id] != null && Number.isFinite(edits[id])) return edits[id] as number;
    seen.add(id);
    const v = (next: string) => value(next);
    let dollars: number;
    switch (id) {
      case '3': dollars = v('1') + v('2'); break;
      case 'A11': dollars = v('4') + v('5') + v('6') + v('7') + v('8') + v('9') + v('10'); break;
      case 'B5': dollars = v('B1') + v('B2') + v('B3') + v('B4'); break;
      case '11': dollars = v('A11') + v('B5'); break;
      case '12': dollars = v('3') - v('11'); break;
      case '13': dollars = roundDollars(v('12') * 0.06); break;
      case '14': dollars = roundDollars(v('12') * 0.0025); break;
      case '15': dollars = roundDollars(v('12') * 0.01); break;
      case '17': dollars = v('13') + v('14') + v('15') + v('16'); break;
      case '19': dollars = v('17') + v('18'); break;
      case '20e': dollars = v('20a') + v('20b') + v('20c') + v('20d'); break;
      case '21': dollars = v('19') - v('20e'); break;
      case '23': dollars = v('21') - v('22'); break;
      case '26': dollars = v('23') + v('24') + v('25'); break;
      default: dollars = floorOf.get(id) ?? 0;
    }
    seen.delete(id);
    return dollars;
  };
  return floor.map((row) => ({
    id: row.id,
    dollars: value(row.id),
    floor: row.dollars,
    edited: row.id !== '24' && edits[row.id] != null && edits[row.id] !== row.dollars,
  }));
}

export function filingBounds(monthStart: string, frequency: CdtfaFrequency) {
  const [year, month] = monthStart.slice(0, 7).split('-').map(Number);
  if (frequency === 'yearly') return { start: `${year}-01-01`, end: `${year}-12-31` };
  if (frequency === 'monthly') return { start: `${year}-${pad(month)}-01`, end: lastDay(year, month) };
  const startMonth = Math.floor((month - 1) / 3) * 3 + 1;
  return { start: `${year}-${pad(startMonth)}-01`, end: lastDay(year, startMonth + 2) };
}

export function dueOn(periodEnd: string) {
  const [year, month] = periodEnd.slice(0, 7).split('-').map(Number);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return lastDay(nextYear, nextMonth);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function periodLabel(start: string, end: string, frequency: CdtfaFrequency, due: string) {
  const [year, month] = start.split('-').map(Number);
  const endMonth = Number(end.slice(5, 7));
  const dueText = `due ${MONTHS[Number(due.slice(5, 7)) - 1]} ${Number(due.slice(8, 10))}`;
  if (frequency === 'yearly') return `${year} · Jan–Dec · ${dueText}`;
  if (frequency === 'monthly') return `${MONTHS[month - 1]} ${year} · ${dueText}`;
  const quarter = Math.floor((month - 1) / 3) + 1;
  return `Q${quarter} ${year} · ${MONTHS[month - 1]}–${MONTHS[endMonth - 1]} · ${dueText}`;
}

export function periodChoices(frequency: CdtfaFrequency, today: string) {
  const choices: { start: string; end: string; due: string; label: string }[] = [];
  let cursor = '2026-07-01';
  const endCap = filingBounds(today, frequency).end;
  while (cursor <= endCap) {
    const bounds = filingBounds(cursor, frequency);
    const due = dueOn(bounds.end);
    choices.push({ ...bounds, due, label: periodLabel(bounds.start, bounds.end, frequency, due) });
    const [year, month] = bounds.end.split('-').map(Number);
    const next = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
    if (next <= cursor) break;
    cursor = next;
  }
  return choices.reverse();
}

function pad(n: number) { return String(n).padStart(2, '0'); }
function lastDay(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
