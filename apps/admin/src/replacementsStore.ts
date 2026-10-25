import { useSyncExternalStore } from 'react';
import { replacementsBySale, type Disposition } from './dispositions';

// Active replacements keyed by original sale id, so any sale row can show "Replacement sent: …".
let current = new Map<number, Disposition[]>();
const listeners = new Set<() => void>();

export function setReplacementRows(rows: Disposition[]) {
  current = replacementsBySale(rows);
  listeners.forEach(fn => fn());
}

export function useReplacementsForSale(saleId: number): Disposition[] | undefined {
  return useSyncExternalStore(
    fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => current,
  ).get(saleId);
}
