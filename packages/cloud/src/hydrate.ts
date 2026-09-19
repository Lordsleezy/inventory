import { cacheUnitRow, wipeCostFromCache, assertCacheHasNoCost } from "./cache.ts";
import type { Db } from "@floor/store";

const FATES = new Set(["issued", "sold", "voided", "hard-deleted", "retired"]);

export type CachePayload = {
  includeCost: boolean;
  ledger?: Array<Record<string, unknown>>;
  units: Array<Record<string, unknown>>;
  sales: Array<Record<string, unknown>>;
  photos: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  listings?: Array<Record<string, unknown>>;
};

export function digitSku(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return /^\d+$/.test(s) ? s : null;
}

function text(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  return String(value);
}

function nullable(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

function nullableJson(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function intOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fateOf(value: unknown, fallback: string): string {
  const s = text(value, fallback);
  return FATES.has(s) ? s : fallback;
}

const KNOWN_TRIGGERS = [
  "sku_ledger_no_delete",
  "sku_ledger_no_rewrite",
  "sales_unit_must_be_sellable",
  "sales_no_delete",
  "sales_immutable",
  "sales_no_unvoid",
  "units_sold_needs_a_sale",
  "units_sold_stays_sold",
  "units_no_delete_while_sold",
  "events_no_update",
  "events_no_delete",
];

export async function dropCacheTriggers(db: Db): Promise<void> {
  const names = new Set(KNOWN_TRIGGERS);
  const listed = await db.all<{ name?: string; Name?: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'",
  );
  for (const row of listed) {
    const n = String(row.name ?? row.Name ?? "");
    if (n) names.add(n);
  }
  for (const name of names) {
    await db.exec(`DROP TRIGGER IF EXISTS "${name.replace(/"/g, '""')}"`);
  }
}

async function clearReplica(db: Db): Promise<void> {
  // Children first. Triggers are already gone so append-only rules cannot block this.
  await db.run("DELETE FROM photos");
  await db.run("DELETE FROM listings");
  await db.run("DELETE FROM events");
  await db.run("DELETE FROM sales");
  await db.run("DELETE FROM units");
  await db.run("DELETE FROM sku_ledger");
}

function collectLedger(payload: CachePayload): Map<string, { issued_at: string; label: string; fate: string }> {
  const rows = new Map<string, { issued_at: string; label: string; fate: string }>();
  const stamp = (sku: string, issuedAt: string, fate: string, label = "") => {
    const prev = rows.get(sku);
    if (!prev) {
      rows.set(sku, { issued_at: issuedAt, label, fate: fateOf(fate, "issued") });
      return;
    }
    if (fate === "sold") prev.fate = "sold";
  };

  for (const row of payload.ledger ?? []) {
    const sku = digitSku(row.sku);
    if (!sku) continue;
    stamp(sku, text(row.issued_at, new Date().toISOString()), text(row.fate, "issued"), text(row.label));
  }
  for (const raw of payload.units) {
    const sku = digitSku(raw.sku);
    if (!sku) continue;
    const issuedAt = text(raw.received_at ?? raw.issued_at, new Date().toISOString());
    stamp(sku, issuedAt, raw.state === "sold" ? "sold" : "issued");
  }
  for (const raw of [...payload.sales, ...payload.photos]) {
    const sku = digitSku(raw.sku);
    if (!sku) continue;
    stamp(sku, text(raw.sold_at ?? raw.created_at, new Date().toISOString()), "issued");
  }
  return rows;
}

async function rebuildEventsWithoutFk(db: Db): Promise<void> {
  const rows = await db.all<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'",
  );
  if (!/REFERENCES/i.test(rows[0]?.sql ?? "")) return;
  await dropCacheTriggers(db);
  await db.exec("PRAGMA foreign_keys = OFF");
  await db.exec("DROP TABLE IF EXISTS events_new");
  await db.exec(`CREATE TABLE IF NOT EXISTS events_new (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    sku TEXT,
    kind TEXT NOT NULL,
    field TEXT,
    old_value TEXT,
    new_value TEXT,
    actor TEXT NOT NULL DEFAULT 'floor',
    note TEXT
  )`);
  await db.exec(
    `INSERT INTO events_new (id, at, sku, kind, field, old_value, new_value, actor, note)
     SELECT id, at, sku, kind, field, old_value, new_value, actor, note FROM events`,
  );
  await db.exec("DROP TABLE events");
  await db.exec("ALTER TABLE events_new RENAME TO events");
  await db.exec("CREATE INDEX IF NOT EXISTS ix_events_sku_at ON events(sku, at)");
}

async function applyOnce(db: Db, payload: CachePayload): Promise<void> {
  await dropCacheTriggers(db);
  await rebuildEventsWithoutFk(db);
  await dropCacheTriggers(db);
  await db.exec("PRAGMA foreign_keys = OFF");
  try {
    await db.tx(async () => {
      await clearReplica(db);

      const ledger = collectLedger(payload);
      const liveSold = new Set(
        payload.sales
          .filter((s) => s.voided_at == null || s.voided_at === "")
          .map((s) => digitSku(s.sku))
          .filter((s): s is string => Boolean(s)),
      );

      for (const [sku, row] of ledger) {
        await db.run(`INSERT INTO sku_ledger (sku, issued_at, label, fate) VALUES (?,?,?,?)`, [
          sku,
          row.issued_at,
          row.label,
          row.fate,
        ]);
      }

      for (const raw of payload.units) {
        const row = cacheUnitRow(raw, { includeCost: payload.includeCost });
        const sku = digitSku(row.sku);
        if (!sku || !ledger.has(sku)) continue;
        const issuedAt = text(row.received_at, new Date().toISOString());
        const actualState = text(row.state, "available");
        const insertState = liveSold.has(sku) ? "available" : actualState;
        await db.run(
          `INSERT INTO units (
            sku, brand, model, title, category, condition, test_status, location, mfr_serial,
            defect_notes, upc, lot, acquisition_cost_cents, msrp_cents, ask_cents, floor_cents,
            state, received_at, updated_at, listing_body, listing_specs, show_on_website
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            sku,
            text(row.brand),
            text(row.model),
            text(row.title),
            nullable(row.category),
            nullable(row.condition),
            nullable(row.test_status),
            nullable(row.location),
            nullable(row.mfr_serial),
            nullable(row.defect_notes),
            nullable(row.upc),
            nullable(row.lot),
            intOrNull(row.acquisition_cost_cents),
            intOrNull(row.msrp_cents),
            intOrNull(row.ask_cents),
            intOrNull(row.floor_cents),
            insertState,
            issuedAt,
            text(row.updated_at, issuedAt),
            nullable(row.listing_body),
            nullableJson(row.listing_specs),
            row.show_on_website === true || row.show_on_website === 1 || row.show_on_website === "1" ? 1 : 0,
          ],
        );
      }

      if (!payload.includeCost) {
        await wipeCostFromCache(db);
        await assertCacheHasNoCost(db);
      }

      for (const s of payload.sales) {
        const sku = digitSku(s.sku);
        if (!sku || !ledger.has(sku)) continue;
        await db.run(
          `INSERT INTO sales (id, sku, price_cents, tax_cents, channel, payment_method, customer_name, customer_phone, customer_email, note, sold_at, receipt_no, voided_at, void_reason, actor)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            intOrNull(s.id),
            sku,
            Number(s.price_cents ?? 0),
            intOrNull(s.tax_cents) ?? 0,
            text(s.channel, "floor"),
            nullable(s.payment_method),
            nullable(s.customer_name),
            nullable(s.customer_phone),
            nullable(s.customer_email),
            nullable(s.note),
            text(s.sold_at, new Date().toISOString()),
            text(s.receipt_no, `r-${sku}`),
            nullable(s.voided_at),
            nullable(s.void_reason),
            nullable(s.actor ?? s.actor_name),
          ],
        );
      }

      for (const sku of liveSold) {
        await db.run("UPDATE units SET state = 'sold' WHERE sku = ?", [sku]);
      }

      for (const p of payload.photos) {
        const sku = digitSku(p.sku);
        if (!sku || !ledger.has(sku)) continue;
        const photoId = intOrNull(p.id);
        const primary = p.is_primary === true || p.is_primary === 1 || p.is_primary === "1" ? 1 : 0;
        if (photoId != null) {
          await db.run(`INSERT INTO photos (id, sku, path, created_at, is_primary) VALUES (?,?,?,?,?)`, [
            photoId,
            sku,
            text(p.path),
            text(p.created_at, new Date().toISOString()),
            primary,
          ]);
        } else {
          await db.run(`INSERT INTO photos (sku, path, created_at, is_primary) VALUES (?,?,?,?)`, [
            sku,
            text(p.path),
            text(p.created_at, new Date().toISOString()),
            primary,
          ]);
        }
      }

      for (const l of payload.listings ?? []) {
        const sku = digitSku(l.sku);
        if (!sku || !ledger.has(sku)) continue;
        const channel = text(l.channel).trim();
        if (!channel) continue;
        await db.run(
          `INSERT INTO listings (sku, channel, status, listing_id, listed_at, delisted_at) VALUES (?,?,?,?,?,?)`,
          [
            sku,
            channel,
            text(l.status, "not_listed"),
            nullable(l.listing_id),
            nullable(l.listed_at),
            nullable(l.delisted_at),
          ],
        );
      }

      for (const e of payload.events) {
        const sku = digitSku(e.sku);
        await db.run(
          `INSERT INTO events (at, sku, kind, field, old_value, new_value, actor, note) VALUES (?,?,?,?,?,?,?,?)`,
          [
            text(e.at, new Date().toISOString()),
            sku && ledger.has(sku) ? sku : null,
            text(e.kind, "note"),
            nullable(e.field),
            nullable(e.old_value),
            nullable(e.new_value),
            text(e.actor, "floor"),
            nullable(e.note),
          ],
        );
      }
    });
  } finally {
    await db.exec("PRAGMA foreign_keys = ON");
  }
}

/** Replace the on-device mirror in one transaction. Retry once if SQLite is mid-constraint. */
export async function applyCachePayload(db: Db, payload: CachePayload): Promise<void> {
  try {
    await applyOnce(db, payload);
  } catch (first) {
    try {
      await applyOnce(db, payload);
    } catch (second) {
      throw second instanceof Error ? second : first;
    }
  }
}
