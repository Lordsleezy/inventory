import { isSku, padSku, type Unit, type UnitState } from "./unit.ts";

export type SkuFate = "issued" | "sold" | "voided" | "hard-deleted" | "retired";

export type SkuLedgerEntry = {
  sku: string;
  issuedAt: string;
  updatedAt: string;
  brand: string;
  model: string;
  title: string;
  fate: SkuFate;
};

export type SkuLedger = {
  entries: Record<string, SkuLedgerEntry>;
};

export function emptySkuLedger(): SkuLedger {
  return { entries: {} };
}

export function fateFromUnitState(state: UnitState): SkuFate {
  if (state === "sold") return "sold";
  if (state === "voided") return "voided";
  return "issued";
}

export function usedSkuMessage(entry: SkuLedgerEntry): string {
  const who = [entry.brand, entry.model].filter(Boolean).join(" ") || entry.title || "an item";
  const fate =
    entry.fate === "hard-deleted"
      ? "hard-deleted"
      : entry.fate === "sold"
        ? "sold"
        : entry.fate === "voided"
          ? "voided"
          : entry.fate === "retired"
            ? "changed to another SKU"
            : "still in inventory";
  return `SKU ${entry.sku} was already used for ${who} (${fate})`;
}

export function lookupSku(ledger: SkuLedger, sku: string): SkuLedgerEntry | null {
  return ledger.entries[sku] ?? null;
}

export function rejectUsedSku(ledger: SkuLedger, sku: string): void {
  const entry = lookupSku(ledger, sku);
  if (entry) {
    throw Object.assign(new Error(usedSkuMessage(entry)), { status: 409 });
  }
}

export function rememberSku(
  ledger: SkuLedger,
  input: {
    sku: string;
    brand: string;
    model: string;
    title: string;
    fate: SkuFate;
    at?: string;
  },
): SkuLedgerEntry {
  const now = input.at ?? new Date().toISOString();
  const prev = ledger.entries[input.sku];
  if (prev?.fate === "hard-deleted") {
    prev.updatedAt = now;
    return prev;
  }
  const entry: SkuLedgerEntry = {
    sku: input.sku,
    issuedAt: prev?.issuedAt ?? now,
    updatedAt: now,
    brand: input.brand || prev?.brand || "",
    model: input.model || prev?.model || "",
    title: input.title || prev?.title || "",
    fate: input.fate,
  };
  ledger.entries[input.sku] = entry;
  return entry;
}

export function rememberUnit(ledger: SkuLedger, unit: Pick<Unit, "sku" | "brand" | "model" | "title" | "state">): SkuLedgerEntry {
  return rememberSku(ledger, {
    sku: unit.sku,
    brand: unit.brand,
    model: unit.model,
    title: unit.title,
    fate: fateFromUnitState(unit.state),
  });
}

export function markHardDeleted(
  ledger: SkuLedger,
  unit: Pick<Unit, "sku" | "brand" | "model" | "title">,
): SkuLedgerEntry {
  const now = new Date().toISOString();
  const prev = ledger.entries[unit.sku];
  const entry: SkuLedgerEntry = {
    sku: unit.sku,
    issuedAt: prev?.issuedAt ?? now,
    updatedAt: now,
    brand: unit.brand || prev?.brand || "",
    model: unit.model || prev?.model || "",
    title: unit.title || prev?.title || "",
    fate: "hard-deleted",
  };
  ledger.entries[unit.sku] = entry;
  return entry;
}

export function retireSku(
  ledger: SkuLedger,
  unit: Pick<Unit, "sku" | "brand" | "model" | "title">,
): SkuLedgerEntry {
  const now = new Date().toISOString();
  const prev = ledger.entries[unit.sku];
  const entry: SkuLedgerEntry = {
    sku: unit.sku,
    issuedAt: prev?.issuedAt ?? now,
    updatedAt: now,
    brand: unit.brand || prev?.brand || "",
    model: unit.model || prev?.model || "",
    title: unit.title || prev?.title || "",
    fate: "retired",
  };
  ledger.entries[unit.sku] = entry;
  return entry;
}

export function occupiedSkus(ledger: SkuLedger): string[] {
  return Object.keys(ledger.entries);
}

export function nextSkuFromOccupied(occupied: Array<string | null | undefined>, skuStart: number): string {
  let max = skuStart - 1;
  for (const serial of occupied) {
    if (!serial || !isSku(serial)) continue;
    const n = Number(serial);
    if (n > max) max = n;
  }
  const next = max + 1;
  if (next > 99999) throw new Error("SKU space exhausted (99999)");
  return padSku(next);
}
