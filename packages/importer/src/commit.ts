import {
  centsToMoneyString,
  lookupSku,
  usedSkuMessage,
  type SkuLedgerEntry,
  type Unit,
} from "@floor/domain";
import {
  InventreeClient,
  inspectUnit,
  loadUnitBySku,
  nextSku,
  priceUnit,
  receiveUnit,
} from "@floor/inventree";
import type { ParsedImportRow } from "./map.ts";

export type ImportResult = {
  line: number;
  sku: string | null;
  status: "created" | "error";
  error: string | null;
};

export async function commitImportRows(
  client: InventreeClient,
  rows: ParsedImportRow[],
  skuStart: number,
  actor: string,
  occupied: SkuLedgerEntry[] = [],
  onIssued?: (unit: Pick<Unit, "sku" | "brand" | "model" | "title" | "state">) => void,
): Promise<ImportResult[]> {
  const out: ImportResult[] = [];
  let allocated = skuStart;
  const ledger = { entries: Object.fromEntries(occupied.map((row) => [row.sku, row])) };
  const existingHint = new Set<string>(occupied.map((row) => row.sku));
  for (const row of rows) {
    if (row.error) {
      out.push({ line: row.line, sku: row.sku, status: "error", error: row.error });
      continue;
    }
    let sku = row.sku;
    if (sku) {
      const ledgerHit = lookupSku(ledger, sku);
      if (ledgerHit) {
        out.push({ line: row.line, sku, status: "error", error: usedSkuMessage(ledgerHit) });
        continue;
      }
      const exists = await loadUnitBySku(client, sku);
      if (exists || existingHint.has(sku)) {
        out.push({
          line: row.line,
          sku,
          status: "error",
          error: `SKU ${sku} already exists — not overwritten`,
        });
        continue;
      }
    } else {
      sku = await nextSku(client, allocated, Object.keys(ledger.entries));
      allocated = Number(sku) + 1;
    }
    try {
      const unit = await receiveUnit(client, {
        brand: row.brand,
        model: row.model,
        title: row.title,
        category: row.category,
        lot: row.lot,
        acquisitionCostCents: row.acquisitionCostCents,
        skuStart,
        sku,
        occupied: Object.values(ledger.entries),
      });
      existingHint.add(sku);
      ledger.entries[sku] = {
        sku,
        issuedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        brand: unit.brand,
        model: unit.model,
        title: unit.title,
        fate: "issued",
      };
      onIssued?.(unit);
      if (row.condition || row.mfrSerial || row.location || row.notes) {
        await inspectUnit(client, {
          sku,
          condition: row.condition,
          testStatus: "untested",
          defectNotes: row.notes,
          mfrSerial: row.mfrSerial,
          location: row.location,
          actor,
        });
      }
      if (
        row.msrpCents !== null ||
        row.retailCents !== null ||
        row.askCents !== null ||
        row.floorCents !== null
      ) {
        await priceUnit(client, {
          sku,
          msrpCents: row.msrpCents,
          retailCents: row.retailCents,
          retailer: row.retailer,
          capturedOn: row.capturedOn,
          askCents: row.askCents,
          floorCents: row.floorCents,
          actor,
          role: "admin",
        });
      }
      out.push({ line: row.line, sku, status: "created", error: null });
    } catch (err) {
      out.push({
        line: row.line,
        sku,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export function moneyPreview(cents: number | null) {
  return centsToMoneyString(cents);
}
