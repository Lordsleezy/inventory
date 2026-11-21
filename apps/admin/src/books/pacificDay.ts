const PACIFIC = 'America/Los_Angeles';

/** Calendar day in Pacific time. A date-only value is kept. A timestamp is converted. */
export function pacificDay(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw.slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

export function pacificStamp(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC, dateStyle: 'medium', timeStyle: 'short',
  }).format(date);
}

export function todayPacific(now = new Date()): string {
  return pacificDay(now.toISOString());
}

export function pacificInRange(value: unknown, start: string, end: string): boolean {
  const day = pacificDay(value);
  return !!day && day >= start && day <= end;
}
