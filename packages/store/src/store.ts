import { DEFAULT_SETTINGS, PRAGMAS, SCHEMA, SCHEMA_VERSION } from "./schema.ts";
import { FloorError, translateDbError, type Db, type SqlValue } from "./db.ts";

export type UnitState =
  | "available"
  | "reserved"
  | "repair"
  | "sold"
  | "voided"
  | "scrapped"
  | "lost";

export type Unit = {
  id: number;
  sku: string;
  brand: string;
  model: string;
  title: string;
  category: string | null;
  condition: string | null;
  testStatus: string | null;
  location: string | null;
  mfrSerial: string | null;
  defectNotes: string | null;
  upc: string | null;
  lot: string | null;
  acquisitionCostCents: number | null;
  msrpCents: number | null;
  askCents: number | null;
  floorCents: number | null;
  state: UnitState;
  receivedAt: string;
  updatedAt: string;
};

export type Sale = {
  id: number;
  sku: string;
  priceCents: number;
  channel: string;
  paymentMethod: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  note: string | null;
  soldAt: string;
  receiptNo: string;
  voidedAt: string | null;
  voidReason: string | null;
};

export type FloorEvent = {
  id: number;
  at: string;
  sku: string | null;
  kind: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  actor: string;
  note: string | null;
};

export type Settings = {
  storeName: string;
  skuStart: number;
  taxRateBps: number;
  currency: string;
  categories: string[];
  conditions: string[];
  testStatuses: string[];
  locations: string[];
  channels: string[];
  paymentMethods: string[];
};

/** Columns a person can edit, and the audit label for each. */
export const EDITABLE_FIELDS = {
  brand: "brand",
  model: "model",
  title: "description",
  category: "category",
  condition: "condition",
  test_status: "test status",
  location: "location",
  mfr_serial: "manufacturer serial",
  defect_notes: "defect notes",
  upc: "UPC",
  lot: "lot",
  acquisition_cost_cents: "cost",
  msrp_cents: "MSRP",
  ask_cents: "ask",
  floor_cents: "floor",
} as const;

export type EditableField = keyof typeof EDITABLE_FIELDS;

const now = () => new Date().toISOString();

export function isSku(value: string): boolean {
  return /^\d{5}$/.test(value);
}

export function padSku(n: number): string {
  return String(n).padStart(5, "0");
}

// ---------------------------------------------------------------- lifecycle

export async function initDb(db: Db): Promise<void> {
  for (const pragma of PRAGMAS) {
    // Some platforms refuse individual pragmas. None of the guarantees rest on
    // them (they are triggers and indexes), so a rejected pragma is not fatal.
    try {
      await db.exec(pragma);
    } catch {
      /* keep going */
    }
  }
  await db.exec(SCHEMA);
  await db.run("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)", [
    String(SCHEMA_VERSION),
  ]);
  await db.run("INSERT OR IGNORE INTO meta(key, value) VALUES ('receipt_seq', '0')");
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.run("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", [
      key,
      JSON.stringify(value),
    ]);
  }
}

// ---------------------------------------------------------------- settings

export async function loadSettings(db: Db): Promise<Settings> {
  const rows = await db.all<{ key: string; value: string }>("SELECT key, value FROM settings");
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      /* a corrupt row falls back to the default rather than breaking startup */
    }
  }
  return out as Settings;
}

export async function saveSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.run(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, JSON.stringify(value)],
  );
}

// ---------------------------------------------------------------- SKUs

/** One past the highest number ever issued. Deleting never lowers this. */
export async function nextSku(db: Db): Promise<string> {
  const settings = await loadSettings(db);
  const rows = await db.all<{ top: string | null }>(
    "SELECT MAX(CAST(sku AS INTEGER)) AS top FROM sku_ledger",
  );
  const top = Number(rows[0]?.top ?? 0);
  const next = Math.max(top + 1, settings.skuStart);
  if (next > 99999) throw new FloorError("SKU numbers are exhausted (99999).", "invalid");
  return padSku(next);
}

export async function skuLedgerEntry(db: Db, sku: string) {
  const rows = await db.all<{ sku: string; issued_at: string; label: string; fate: string }>(
    "SELECT sku, issued_at, label, fate FROM sku_ledger WHERE sku = ?",
    [sku],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- mapping

function toUnit(row: Record<string, SqlValue>): Unit {
  return {
    id: Number(row.id),
    sku: String(row.sku),
    brand: String(row.brand ?? ""),
    model: String(row.model ?? ""),
    title: String(row.title ?? ""),
    category: (row.category as string) ?? null,
    condition: (row.condition as string) ?? null,
    testStatus: (row.test_status as string) ?? null,
    location: (row.location as string) ?? null,
    mfrSerial: (row.mfr_serial as string) ?? null,
    defectNotes: (row.defect_notes as string) ?? null,
    upc: (row.upc as string) ?? null,
    lot: (row.lot as string) ?? null,
    acquisitionCostCents: row.acquisition_cost_cents === null ? null : Number(row.acquisition_cost_cents),
    msrpCents: row.msrp_cents === null ? null : Number(row.msrp_cents),
    askCents: row.ask_cents === null ? null : Number(row.ask_cents),
    floorCents: row.floor_cents === null ? null : Number(row.floor_cents),
    state: String(row.state) as UnitState,
    receivedAt: String(row.received_at),
    updatedAt: String(row.updated_at),
  };
}

function toSale(row: Record<string, SqlValue>): Sale {
  return {
    id: Number(row.id),
    sku: String(row.sku),
    priceCents: Number(row.price_cents),
    channel: String(row.channel),
    paymentMethod: (row.payment_method as string) ?? null,
    customerName: (row.customer_name as string) ?? null,
    customerPhone: (row.customer_phone as string) ?? null,
    customerEmail: (row.customer_email as string) ?? null,
    note: (row.note as string) ?? null,
    soldAt: String(row.sold_at),
    receiptNo: String(row.receipt_no),
    voidedAt: (row.voided_at as string) ?? null,
    voidReason: (row.void_reason as string) ?? null,
  };
}

// ---------------------------------------------------------------- audit

async function record(
  db: Db,
  input: {
    sku: string | null;
    kind: string;
    field?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
    actor?: string;
    note?: string | null;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO events(at, sku, kind, field, old_value, new_value, actor, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      now(),
      input.sku,
      input.kind,
      input.field ?? null,
      input.oldValue ?? null,
      input.newValue ?? null,
      input.actor ?? "floor",
      input.note ?? null,
    ],
  );
}

export async function unitHistory(db: Db, sku: string): Promise<FloorEvent[]> {
  const rows = await db.all<Record<string, SqlValue>>(
    "SELECT * FROM events WHERE sku = ? ORDER BY at DESC, id DESC",
    [sku],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    at: String(row.at),
    sku: (row.sku as string) ?? null,
    kind: String(row.kind),
    field: (row.field as string) ?? null,
    oldValue: (row.old_value as string) ?? null,
    newValue: (row.new_value as string) ?? null,
    actor: String(row.actor),
    note: (row.note as string) ?? null,
  }));
}

// ---------------------------------------------------------------- receive

export type ReceiveInput = {
  sku?: string;
  brand?: string;
  model?: string;
  title?: string;
  category?: string | null;
  condition?: string | null;
  testStatus?: string | null;
  location?: string | null;
  mfrSerial?: string | null;
  defectNotes?: string | null;
  upc?: string | null;
  lot?: string | null;
  acquisitionCostCents?: number | null;
  msrpCents?: number | null;
  askCents?: number | null;
  floorCents?: number | null;
  actor?: string;
};

export async function receiveUnit(db: Db, input: ReceiveInput): Promise<Unit> {
  const sku = input.sku ?? (await nextSku(db));
  if (!isSku(sku)) throw new FloorError("A SKU is five digits.", "invalid");

  const label = [input.brand, input.model].filter(Boolean).join(" ") || input.title || "";
  const stamp = now();

  try {
    return await db.tx(async () => {
      // Fails if this number was ever issued, including to something deleted.
      await db.run("INSERT INTO sku_ledger(sku, issued_at, label, fate) VALUES (?, ?, ?, 'issued')", [
        sku,
        stamp,
        label,
      ]);
      await db.run(
        `INSERT INTO units(
           sku, brand, model, title, category, condition, test_status, location,
           mfr_serial, defect_notes, upc, lot,
           acquisition_cost_cents, msrp_cents, ask_cents, floor_cents,
           state, received_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'available',?,?)`,
        [
          sku,
          input.brand ?? "",
          input.model ?? "",
          input.title ?? "",
          input.category ?? null,
          input.condition ?? null,
          input.testStatus ?? null,
          input.location ?? null,
          input.mfrSerial ?? null,
          input.defectNotes ?? null,
          input.upc ?? null,
          input.lot ?? null,
          input.acquisitionCostCents ?? null,
          input.msrpCents ?? null,
          input.askCents ?? null,
          input.floorCents ?? null,
          stamp,
          stamp,
        ],
      );
      await record(db, { sku, kind: "received", actor: input.actor, note: label || null });
      const unit = await loadUnit(db, sku);
      if (!unit) throw new FloorError("Received but could not be read back.", "not_found");
      return unit;
    });
  } catch (err) {
    throw translateDbError(err, { sku });
  }
}

// ---------------------------------------------------------------- read

export async function loadUnit(db: Db, sku: string): Promise<Unit | null> {
  const rows = await db.all<Record<string, SqlValue>>("SELECT * FROM units WHERE sku = ?", [sku]);
  return rows[0] ? toUnit(rows[0]) : null;
}

export async function listUnits(
  db: Db,
  opts: { query?: string; states?: UnitState[]; limit?: number } = {},
): Promise<Unit[]> {
  const where: string[] = [];
  const params: SqlValue[] = [];

  const q = (opts.query ?? "").trim();
  if (q) {
    where.push("(sku LIKE ? OR brand LIKE ? OR model LIKE ? OR title LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (opts.states?.length) {
    where.push(`state IN (${opts.states.map(() => "?").join(",")})`);
    params.push(...opts.states);
  }

  const sql = `SELECT * FROM units ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY CAST(sku AS INTEGER) DESC
               ${opts.limit ? "LIMIT ?" : ""}`;
  if (opts.limit) params.push(opts.limit);

  const rows = await db.all<Record<string, SqlValue>>(sql, params);
  return rows.map(toUnit);
}

// ---------------------------------------------------------------- edit

/** Patch keyed by database column. Writes one immutable event per change. */
export async function updateUnit(
  db: Db,
  sku: string,
  patch: Partial<Record<EditableField, SqlValue>>,
  actor = "floor",
): Promise<Unit> {
  const before = await loadUnit(db, sku);
  if (!before) throw new FloorError(`No unit with SKU ${sku}.`, "not_found");

  const raw = before as unknown as Record<string, unknown>;
  const camel: Record<EditableField, unknown> = {
    brand: raw.brand,
    model: raw.model,
    title: raw.title,
    category: raw.category,
    condition: raw.condition,
    test_status: raw.testStatus,
    location: raw.location,
    mfr_serial: raw.mfrSerial,
    defect_notes: raw.defectNotes,
    upc: raw.upc,
    lot: raw.lot,
    acquisition_cost_cents: raw.acquisitionCostCents,
    msrp_cents: raw.msrpCents,
    ask_cents: raw.askCents,
    floor_cents: raw.floorCents,
  };

  const changes = (Object.keys(patch) as EditableField[]).filter((key) => {
    if (!(key in EDITABLE_FIELDS)) return false;
    const next = patch[key] ?? null;
    const prev = camel[key] ?? null;
    return String(next ?? "") !== String(prev ?? "");
  });

  if (changes.length === 0) return before;

  try {
    return await db.tx(async () => {
      const sets = changes.map((key) => `${key} = ?`).join(", ");
      const params: SqlValue[] = changes.map((key) => patch[key] ?? null);
      params.push(now(), sku);
      await db.run(`UPDATE units SET ${sets}, updated_at = ? WHERE sku = ?`, params);

      for (const key of changes) {
        await record(db, {
          sku,
          kind: "edit",
          field: EDITABLE_FIELDS[key],
          oldValue: camel[key] === null || camel[key] === undefined ? null : String(camel[key]),
          newValue: patch[key] === null || patch[key] === undefined ? null : String(patch[key]),
          actor,
        });
      }

      const after = await loadUnit(db, sku);
      if (!after) throw new FloorError("Unit vanished mid-edit.", "not_found");
      return after;
    });
  } catch (err) {
    throw translateDbError(err, { sku });
  }
}

export async function setUnitState(
  db: Db,
  sku: string,
  state: UnitState,
  actor = "floor",
  note?: string,
): Promise<Unit> {
  const before = await loadUnit(db, sku);
  if (!before) throw new FloorError(`No unit with SKU ${sku}.`, "not_found");
  if (before.state === state) return before;

  try {
    return await db.tx(async () => {
      await db.run("UPDATE units SET state = ?, updated_at = ? WHERE sku = ?", [state, now(), sku]);
      if (state === "voided") {
        await db.run("UPDATE sku_ledger SET fate = 'voided' WHERE sku = ?", [sku]);
      }
      await record(db, {
        sku,
        kind: "state",
        field: "state",
        oldValue: before.state,
        newValue: state,
        actor,
        note: note ?? null,
      });
      const after = await loadUnit(db, sku);
      if (!after) throw new FloorError("Unit vanished.", "not_found");
      return after;
    });
  } catch (err) {
    throw translateDbError(err, { sku });
  }
}

// ---------------------------------------------------------------- sell

export type SellInput = {
  sku: string;
  priceCents: number;
  channel: string;
  paymentMethod?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  note?: string | null;
  actor?: string;
};

async function nextReceiptNo(db: Db): Promise<string> {
  await db.run("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'receipt_seq'");
  const rows = await db.all<{ value: string }>("SELECT value FROM meta WHERE key = 'receipt_seq'");
  return `R-${String(rows[0]?.value ?? "1").padStart(5, "0")}`;
}

/**
 * Sell a unit. The partial unique index makes a second live sale impossible,
 * so this does not need to check first — it just tries, and the database is
 * the authority on whether it was allowed.
 */
export async function sellUnit(db: Db, input: SellInput): Promise<Sale> {
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
    throw new FloorError("Enter what you actually got for it.", "invalid");
  }
  if (!input.channel.trim()) throw new FloorError("Pick a channel.", "invalid");

  try {
    return await db.tx(async () => {
      const receiptNo = await nextReceiptNo(db);
      const soldAt = now();
      const res = await db.run(
        `INSERT INTO sales(
           sku, price_cents, channel, payment_method,
           customer_name, customer_phone, customer_email, note, sold_at, receipt_no)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          input.sku,
          input.priceCents,
          input.channel.trim(),
          input.paymentMethod ?? null,
          input.customerName ?? null,
          input.customerPhone ?? null,
          input.customerEmail ?? null,
          input.note ?? null,
          soldAt,
          receiptNo,
        ],
      );
      await db.run("UPDATE units SET state = 'sold', updated_at = ? WHERE sku = ?", [soldAt, input.sku]);
      await db.run("UPDATE sku_ledger SET fate = 'sold' WHERE sku = ?", [input.sku]);
      await record(db, {
        sku: input.sku,
        kind: "sold",
        newValue: String(input.priceCents),
        actor: input.actor,
        note: `${input.channel} ${receiptNo}`,
      });
      const rows = await db.all<Record<string, SqlValue>>("SELECT * FROM sales WHERE id = ?", [
        res.lastId,
      ]);
      return toSale(rows[0]);
    });
  } catch (err) {
    throw translateDbError(err, { sku: input.sku });
  }
}

export async function voidSale(
  db: Db,
  saleId: number,
  reason: string,
  actor = "floor",
): Promise<void> {
  if (!reason.trim()) throw new FloorError("A void needs a reason.", "invalid");
  const rows = await db.all<Record<string, SqlValue>>("SELECT * FROM sales WHERE id = ?", [saleId]);
  if (!rows[0]) throw new FloorError("No such sale.", "not_found");
  const sale = toSale(rows[0]);
  if (sale.voidedAt) throw new FloorError("That sale is already voided.", "immutable");

  try {
    await db.tx(async () => {
      // Unit first: the trigger blocks leaving 'sold' while a live sale exists,
      // so the sale has to be voided before the unit can come back.
      await db.run("UPDATE sales SET voided_at = ?, void_reason = ? WHERE id = ?", [
        now(),
        reason.trim(),
        saleId,
      ]);
      await db.run("UPDATE units SET state = 'available', updated_at = ? WHERE sku = ?", [
        now(),
        sale.sku,
      ]);
      await db.run("UPDATE sku_ledger SET fate = 'issued' WHERE sku = ?", [sale.sku]);
      await record(db, {
        sku: sale.sku,
        kind: "sale_void",
        oldValue: sale.receiptNo,
        actor,
        note: reason.trim(),
      });
    });
  } catch (err) {
    throw translateDbError(err, { sku: sale.sku });
  }
}

export async function saleForSku(db: Db, sku: string): Promise<Sale | null> {
  const rows = await db.all<Record<string, SqlValue>>(
    "SELECT * FROM sales WHERE sku = ? AND voided_at IS NULL",
    [sku],
  );
  return rows[0] ? toSale(rows[0]) : null;
}

export async function salesHistory(
  db: Db,
  opts: { query?: string; includeVoided?: boolean } = {},
): Promise<Sale[]> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (!opts.includeVoided) where.push("voided_at IS NULL");
  const q = (opts.query ?? "").trim();
  if (q) {
    where.push("(sku LIKE ? OR customer_name LIKE ? OR receipt_no LIKE ? OR sold_at LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const rows = await db.all<Record<string, SqlValue>>(
    `SELECT * FROM sales ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY sold_at DESC, id DESC`,
    params,
  );
  return rows.map(toSale);
}

// ---------------------------------------------------------------- delete

/** Hard delete. The number stays spent forever. */
export async function deleteUnit(db: Db, sku: string, actor = "floor"): Promise<void> {
  const unit = await loadUnit(db, sku);
  if (!unit) throw new FloorError(`No unit with SKU ${sku}.`, "not_found");
  try {
    await db.tx(async () => {
      await db.run("DELETE FROM photos WHERE sku = ?", [sku]);
      await db.run("DELETE FROM units WHERE sku = ?", [sku]);
      await db.run("UPDATE sku_ledger SET fate = 'hard-deleted' WHERE sku = ?", [sku]);
      await record(db, {
        sku,
        kind: "deleted",
        oldValue: [unit.brand, unit.model].filter(Boolean).join(" ") || unit.title,
        actor,
      });
    });
  } catch (err) {
    throw translateDbError(err, { sku });
  }
}

// ---------------------------------------------------------------- photos

export async function addPhoto(db: Db, sku: string, path: string): Promise<void> {
  await db.tx(async () => {
    const existing = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM photos WHERE sku = ?", [sku]);
    const first = Number(existing[0]?.n ?? 0) === 0;
    await db.run("INSERT INTO photos(sku, path, created_at, is_primary) VALUES (?,?,?,?)", [
      sku,
      path,
      now(),
      first ? 1 : 0,
    ]);
    await record(db, { sku, kind: "photo", newValue: path });
  });
}

export async function listPhotos(db: Db, sku: string) {
  return db.all<{ id: number; sku: string; path: string; created_at: string; is_primary: number }>(
    "SELECT * FROM photos WHERE sku = ? ORDER BY is_primary DESC, id ASC",
    [sku],
  );
}

export async function removePhoto(db: Db, id: number): Promise<void> {
  const rows = await db.all<{ sku: string; path: string }>(
    "SELECT sku, path FROM photos WHERE id = ?",
    [id],
  );
  if (!rows[0]) return;
  await db.tx(async () => {
    await db.run("DELETE FROM photos WHERE id = ?", [id]);
    await record(db, { sku: rows[0].sku, kind: "photo_removed", oldValue: rows[0].path });
  });
}

// ---------------------------------------------------------------- reports

export type Reports = {
  inStock: number;
  moneyTiedUpCents: number;
  askValueCents: number;
  soldThisWeek: number;
  soldThisWeekCents: number;
  agingBuckets: { label: string; count: number }[];
};

const IN_STOCK: UnitState[] = ["available", "reserved", "repair"];

export async function reports(db: Db, at = new Date()): Promise<Reports> {
  const marks = IN_STOCK.map(() => "?").join(",");

  const stock = await db.all<{ n: number; cost: number | null; ask: number | null }>(
    `SELECT COUNT(*) AS n,
            SUM(COALESCE(acquisition_cost_cents, 0)) AS cost,
            SUM(COALESCE(ask_cents, 0)) AS ask
       FROM units WHERE state IN (${marks})`,
    IN_STOCK,
  );

  const weekAgo = new Date(at.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const week = await db.all<{ n: number; total: number | null }>(
    "SELECT COUNT(*) AS n, SUM(price_cents) AS total FROM sales WHERE voided_at IS NULL AND sold_at >= ?",
    [weekAgo],
  );

  const rows = await db.all<{ received_at: string }>(
    `SELECT received_at FROM units WHERE state IN (${marks})`,
    IN_STOCK,
  );
  const buckets = [
    { label: "0-30 days", count: 0 },
    { label: "31-60 days", count: 0 },
    { label: "61-90 days", count: 0 },
    { label: "90+ days", count: 0 },
  ];
  for (const row of rows) {
    const days = Math.floor((at.getTime() - new Date(row.received_at).getTime()) / 86400000);
    if (days <= 30) buckets[0].count += 1;
    else if (days <= 60) buckets[1].count += 1;
    else if (days <= 90) buckets[2].count += 1;
    else buckets[3].count += 1;
  }

  return {
    inStock: Number(stock[0]?.n ?? 0),
    moneyTiedUpCents: Number(stock[0]?.cost ?? 0),
    askValueCents: Number(stock[0]?.ask ?? 0),
    soldThisWeek: Number(week[0]?.n ?? 0),
    soldThisWeekCents: Number(week[0]?.total ?? 0),
    agingBuckets: buckets,
  };
}
