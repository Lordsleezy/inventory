import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { RegisterUnit } from './units';

export type CartLine = {
  sku: string;
  title: string;
  condition: string | null;
  askCents: number | null;
  priceCents: number;
  overrideReason: string;
  approvalId: string | null;
  qty: number;
  qtyOnHand: number;
  photoUrl: string | null;
  bundleIncludes?: { sku: string; title: string; quantity: number }[];
};

type CartValue = {
  lines: CartLine[];
  note: string;
  setNote: (note: string) => void;
  ticketId: string;
  resetTicketId: () => void;
  addUnit: (unit: RegisterUnit, opts?: { priceCents?: number; overrideReason?: string; bundleIncludes?: CartLine['bundleIncludes'] }) => void;
  removeSku: (sku: string) => void;
  updateLine: (sku: string, patch: Partial<CartLine>) => void;
  setQty: (sku: string, qty: number) => void;
  clear: () => void;
};

const Ctx = createContext<CartValue | null>(null);

export function useCart(): CartValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCart outside provider');
  return v;
}

function newTicketId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* older webviews */ }
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [note, setNote] = useState('');
  const [ticketId, setTicketId] = useState(newTicketId);

  const addUnit = useCallback((unit: RegisterUnit, opts?: { priceCents?: number; overrideReason?: string; bundleIncludes?: CartLine['bundleIncludes'] }) => {
    setLines(prev => {
      const existing = prev.find(l => l.sku === unit.sku);
      const maxQty = unit.qtyOnHand > 1 ? unit.qtyOnHand : 1;
      const priceCents = opts?.priceCents ?? unit.askCents ?? 0;
      const overrideReason = opts?.overrideReason
        ?? (unit.askCents != null && priceCents !== unit.askCents ? 'Sale price' : '');
      if (existing) {
        if (maxQty <= 1) {
          return prev.map(l => (l.sku === unit.sku
            ? { ...l, priceCents, overrideReason, approvalId: null, bundleIncludes: opts?.bundleIncludes ?? l.bundleIncludes }
            : l));
        }
        const nextQty = Math.min(maxQty, existing.qty + 1);
        return prev.map(l => (l.sku === unit.sku
          ? { ...l, qty: nextQty, priceCents, overrideReason, approvalId: null, bundleIncludes: opts?.bundleIncludes ?? l.bundleIncludes }
          : l));
      }
      const title = [unit.brand, unit.model].filter(Boolean).join(' ') || unit.title;
      return [
        ...prev,
        {
          sku: unit.sku,
          title,
          condition: unit.condition,
          askCents: unit.askCents,
          priceCents,
          overrideReason,
          approvalId: null,
          qty: 1,
          qtyOnHand: maxQty,
          photoUrl: unit.photoUrl,
          bundleIncludes: opts?.bundleIncludes,
        },
      ];
    });
  }, []);

  const removeSku = useCallback((sku: string) => {
    setLines(prev => prev.filter(l => l.sku !== sku));
  }, []);

  const updateLine = useCallback((sku: string, patch: Partial<CartLine>) => {
    setLines(prev => prev.map(l => (l.sku === sku ? { ...l, ...patch } : l)));
  }, []);

  const setQty = useCallback((sku: string, qty: number) => {
    setLines(prev =>
      prev.map(l => {
        if (l.sku !== sku) return l;
        const max = l.qtyOnHand > 1 ? l.qtyOnHand : 1;
        return { ...l, qty: Math.max(1, Math.min(max, Math.round(qty))) };
      }),
    );
  }, []);

  const clear = useCallback(() => {
    setLines([]);
    setNote('');
    setTicketId(newTicketId());
  }, []);

  const resetTicketId = useCallback(() => setTicketId(newTicketId()), []);

  const value = useMemo(
    () => ({ lines, note, setNote, ticketId, resetTicketId, addUnit, removeSku, updateLine, setQty, clear }),
    [lines, note, ticketId, resetTicketId, addUnit, removeSku, updateLine, setQty, clear],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
