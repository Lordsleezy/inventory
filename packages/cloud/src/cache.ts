import type { Db } from "@floor/store";
import { stripCostFromUnit } from "./sell.ts";

const COST_SQL = `UPDATE units SET acquisition_cost_cents = NULL, floor_cents = NULL`;

export async function assertCacheHasNoCost(db: Db): Promise<void> {
  const rows = await db.all<{ n: number }>(
    "SELECT COUNT(*) AS n FROM units WHERE acquisition_cost_cents IS NOT NULL OR floor_cents IS NOT NULL",
  );
  if (Number(rows[0]?.n ?? 0) > 0) {
    throw new Error("offline cache contained cost or floor; those fields were stripped");
  }
}

export async function wipeCostFromCache(db: Db): Promise<void> {
  await db.run(COST_SQL);
}

/**
 * Phone SQLite is a replica of the cloud, not the ledger. Drop the
 * append-only triggers so hydrate can replace rows, then recreate them.
 */
export async function resetCacheReplica(db: Db): Promise<void> {
  const triggers = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'",
  );
  for (const trigger of triggers) {
    await db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
  }
  await db.run("DELETE FROM photos");
  await db.run("DELETE FROM listings");
  await db.run("DELETE FROM events");
  await db.run("DELETE FROM sales");
  await db.run("DELETE FROM units");
  await db.run("DELETE FROM sku_ledger");
}

export async function relockCacheReplica(_db: Db): Promise<void> {
  // Phone SQLite is a disposable mirror of Supabase. Recreating SCHEMA would
  // restore append-only triggers that block the next hydrate.
}

/** Map a cloud row into cache columns. Staff never get cost or floor. */
export function cacheUnitRow(
  row: Record<string, unknown>,
  opts: { includeCost?: boolean } = {},
): Record<string, unknown> {
  const stripped = stripCostFromUnit(row);
  return {
    sku: stripped.sku,
    brand: stripped.brand ?? "",
    model: stripped.model ?? "",
    title: stripped.title ?? "",
    category: stripped.category ?? null,
    condition: stripped.condition ?? null,
    test_status: stripped.test_status ?? null,
    location: stripped.location ?? null,
    mfr_serial: stripped.mfr_serial ?? null,
    defect_notes: stripped.defect_notes ?? null,
    upc: stripped.upc ?? null,
    lot: stripped.lot ?? null,
    msrp_cents: stripped.msrp_cents ?? null,
    ask_cents: stripped.ask_cents ?? null,
    state: stripped.state ?? "available",
    received_at: stripped.received_at,
    updated_at: stripped.updated_at,
    acquisition_cost_cents: opts.includeCost ? (row.acquisition_cost_cents ?? null) : null,
    floor_cents: opts.includeCost ? (row.floor_cents ?? null) : null,
  };
}
