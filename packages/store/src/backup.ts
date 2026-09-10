import type { Db, SqlValue } from "./db.ts";
import { SCHEMA, SCHEMA_VERSION } from "./schema.ts";

/**
 * Backup and restore.
 *
 * A snapshot is every row of every table as plain JSON. Photos are files and
 * are backed up alongside it by the app layer; `photoPaths` is the manifest
 * so a restore can tell whether any image is missing.
 */

const TABLES = ["meta", "settings", "sku_ledger", "units", "sales", "events", "photos"] as const;

export type Snapshot = {
  format: "floor-backup";
  schemaVersion: number;
  exportedAt: string;
  counts: Record<string, number>;
  photoPaths: string[];
  tables: Record<string, Record<string, SqlValue>[]>;
  /** Present only in a full backup: photo path -> base64 image. */
  photoData?: Record<string, string>;
};

export async function exportSnapshot(db: Db): Promise<Snapshot> {
  const tables: Record<string, Record<string, SqlValue>[]> = {};
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const rows = await db.all<Record<string, SqlValue>>(`SELECT * FROM ${table}`);
    tables[table] = rows;
    counts[table] = rows.length;
  }
  return {
    format: "floor-backup",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    counts,
    photoPaths: (tables.photos ?? []).map((row) => String(row.path)),
    tables,
  };
}

export function assertRestorable(snapshot: unknown): Snapshot {
  if (!snapshot || typeof snapshot !== "object") throw new Error("That file is not a Floor backup.");
  const snap = snapshot as Snapshot;
  if (snap.format !== "floor-backup") throw new Error("That file is not a Floor backup.");
  if (typeof snap.schemaVersion !== "number") throw new Error("Backup is missing its version.");
  if (snap.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `That backup was written by a newer version of Floor (v${snap.schemaVersion}). Update the app first.`,
    );
  }
  if (!snap.tables || typeof snap.tables !== "object") throw new Error("Backup has no data in it.");
  if (!Array.isArray(snap.tables.sku_ledger)) throw new Error("Backup is missing the SKU ledger.");
  return snap;
}

/**
 * Replace everything in the database with the snapshot.
 *
 * Restore is the one privileged operation in the system: it has to drop the
 * append-only triggers, because those triggers exist precisely to stop rows
 * being removed. They are recreated before the transaction commits, so either
 * the restore lands whole with its guarantees intact or nothing changes at all.
 */
export async function restoreSnapshot(db: Db, input: unknown): Promise<Record<string, number>> {
  const snapshot = assertRestorable(input);

  const triggers = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'",
  );

  return db.tx(async () => {
    for (const trigger of triggers) await db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);

    // Children before parents: units and sales reference the ledger.
    for (const table of [...TABLES].reverse()) await db.run(`DELETE FROM ${table}`);

    const written: Record<string, number> = {};
    for (const table of TABLES) {
      const rows = snapshot.tables[table] ?? [];
      for (const row of rows) {
        const cols = Object.keys(row);
        if (cols.length === 0) continue;
        await db.run(
          `INSERT INTO ${table}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
          cols.map((col) => row[col] ?? null),
        );
      }
      written[table] = rows.length;
    }

    // CREATE ... IF NOT EXISTS, so this puts the guarantees back.
    await db.exec(SCHEMA);
    return written;
  });
}
