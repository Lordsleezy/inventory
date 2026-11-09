import { canonicalPersonKey, canonicalPersonLabel } from './books/personMerge.ts';

export type DayPart = 'morning' | 'afternoon' | 'evening';

/** Morning until noon, afternoon until 5pm, evening after. Hour is local (0–23). */
export function dayPart(hour: number): DayPart {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

export const GREETINGS: Record<DayPart, readonly string[]> = {
  morning: ['Good morning', 'Rise and shine', 'Morning', 'Up and at it', 'Hello'],
  afternoon: ['Good afternoon', "Hope the day's going well", 'Afternoon', 'Good to see you'],
  evening: ['Good evening', 'Welcome back', 'Back at it', 'Evening'],
};

const ROLE_LABEL = /^(admin|owner|manager|staff)$/i;

/** First name from the account. A role label such as Admin uses the person this login already maps to. */
export function firstName(displayName: string | null | undefined, email: string | null | undefined): string {
  const raw = (displayName || '').trim();
  const first = raw.split(/\s+/)[0] || '';
  if (raw && !raw.includes('@') && !ROLE_LABEL.test(first)) return first;
  const known = canonicalPersonKey(raw, email);
  if (known) return canonicalPersonLabel(known);
  const local = (email || '').split('@')[0] || '';
  const bit = local.split(/[.+_-]/)[0] || local;
  if (!bit) return 'there';
  return bit.charAt(0).toUpperCase() + bit.slice(1);
}

/** A line for this part of day, never the same phrase twice in a row. */
export function pickGreeting(part: DayPart, previous: string | null, rand: () => number = Math.random): string {
  const pool = GREETINGS[part];
  const choices = previous ? pool.filter((g) => g !== previous) : [...pool];
  const list = choices.length ? choices : [...pool];
  const index = Math.min(list.length - 1, Math.floor(rand() * list.length));
  return list[index];
}

export const GREETING_STORAGE_KEY = 'floor_home_greeting';
