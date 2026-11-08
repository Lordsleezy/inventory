import type { Period } from './types';
import { monthLabel } from './booksMath';

const laToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

export type PeriodUiStatus = 'locked' | 'in_progress' | 'draft';

export function periodUiStatus(p: Period, today = laToday()): PeriodUiStatus {
  if (p.status === 'locked') return 'locked';
  const cur = today.slice(0, 7);
  if (p.period_start.slice(0, 7) === cur) return 'in_progress';
  return 'draft';
}

export function periodStatusLabel(status: PeriodUiStatus) {
  if (status === 'locked') return 'Locked';
  if (status === 'in_progress') return 'In progress';
  return 'Draft';
}

export function periodPickerLabel(p: Period) {
  return monthLabel(p.period_start);
}
