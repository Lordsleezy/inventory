import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { CachedUnit } from "./local";

export type CartLine = {
  sku: string;
  title: string;
  condition: string | null;
  askCents: number | null;
  priceCents: number;
  overrideReason: string;
  approvalId: string | null;
};

type CartValue = {
  lines: CartLine[];
  addUnit: (unit: CachedUnit) => void;
  removeSku: (sku: string) => void;
  updateLine: (sku: string, patch: Partial<CartLine>) => void;
  clear: () => void;
};

const Ctx = createContext<CartValue | null>(null);

export function useCart(): CartValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCart outside provider");
  return v;
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);

  const addUnit = useCallback((unit: CachedUnit) => {
    setLines((prev) => {
      if (prev.some((l) => l.sku === unit.sku)) return prev;
      const title = [unit.brand, unit.model].filter(Boolean).join(" ") || unit.title;
      return [
        ...prev,
        {
          sku: unit.sku,
          title,
          condition: unit.condition,
          askCents: unit.askCents,
          priceCents: unit.askCents ?? 0,
          overrideReason: "",
          approvalId: null,
        },
      ];
    });
  }, []);

  const removeSku = useCallback((sku: string) => {
    setLines((prev) => prev.filter((l) => l.sku !== sku));
  }, []);

  const updateLine = useCallback((sku: string, patch: Partial<CartLine>) => {
    setLines((prev) => prev.map((l) => (l.sku === sku ? { ...l, ...patch } : l)));
  }, []);

  const clear = useCallback(() => setLines([]), []);

  const value = useMemo(
    () => ({ lines, addUnit, removeSku, updateLine, clear }),
    [lines, addUnit, removeSku, updateLine, clear],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
