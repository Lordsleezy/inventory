import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  emptySkuLedger,
  lookupSku,
  markHardDeleted,
  occupiedSkus,
  rememberSku,
  rememberUnit,
  usedSkuMessage,
  type SkuFate,
  type SkuLedger,
  type Unit,
} from "@floor/domain";
import { floorRoot } from "./inventree";
import type { InventreeClient } from "@floor/inventree";
import { loadUnitBySku } from "@floor/inventree";

export function skuLedgerPath() {
  return join(floorRoot(), "data", "sku-ledger.json");
}

export function loadSkuLedger(): SkuLedger {
  const path = skuLedgerPath();
  if (!existsSync(path)) return emptySkuLedger();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries?: SkuLedger["entries"] };
    return { entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {} };
  } catch {
    return emptySkuLedger();
  }
}

export function saveSkuLedger(ledger: SkuLedger) {
  mkdirSync(join(floorRoot(), "data"), { recursive: true });
  writeFileSync(skuLedgerPath(), JSON.stringify(ledger, null, 2) + "\n");
}

export function recordIssued(unit: Pick<Unit, "sku" | "brand" | "model" | "title" | "state">) {
  const ledger = loadSkuLedger();
  rememberUnit(ledger, unit);
  saveSkuLedger(ledger);
}

export function recordFate(
  unit: Pick<Unit, "sku" | "brand" | "model" | "title">,
  fate: SkuFate,
) {
  const ledger = loadSkuLedger();
  if (fate === "hard-deleted") markHardDeleted(ledger, unit);
  else rememberSku(ledger, { ...unit, fate });
  saveSkuLedger(ledger);
}

export function ledgerOccupied(): string[] {
  return occupiedSkus(loadSkuLedger());
}

/** Live/sold/voided from InvenTree, plus every SKU ever issued (including hard-deleted). */
export async function assertSkuAvailable(client: InventreeClient, sku: string) {
  const live = await loadUnitBySku(client, sku);
  if (live) {
    recordIssued(live);
    throw Object.assign(new Error(usedSkuMessage(lookupSku(loadSkuLedger(), sku)!)), { status: 409 });
  }
  const hit = lookupSku(loadSkuLedger(), sku);
  if (hit) {
    throw Object.assign(new Error(usedSkuMessage(hit)), { status: 409 });
  }
}
