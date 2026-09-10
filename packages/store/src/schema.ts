/**
 * The whole of Floor's on-device database.
 *
 * Every rule that matters is enforced here rather than in a screen, because
 * screens get rewritten and constraints do not. In particular:
 *
 *   - A SKU can never be sold twice. `ux_one_live_sale_per_sku` is a partial
 *     unique index, so a second live sale is physically unrepresentable. The
 *     UI does not get a vote.
 *   - A SKU is never reused. `sku_ledger` rows cannot be deleted, and every
 *     new SKU is drawn from past the highest row that has ever existed.
 *   - History is never rewritten. `events` refuses UPDATE and DELETE.
 *   - Money is integer cents and nullable. NULL means nobody has priced it,
 *     which is a different fact from 0.
 *
 * Nothing here knows what an appliance is. Categories, conditions, test
 * statuses, locations, channels and payment methods are all rows in
 * `settings`, so a pallet of power tools needs no schema change.
 */

export const SCHEMA_VERSION = 1;

/** Run on every connection, before anything else. */
export const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
] as const;

export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Every SKU ever issued. Append-only for the life of the business.
-- A row here means the number is spent, whatever happened to the thing.
CREATE TABLE IF NOT EXISTS sku_ledger (
  sku       TEXT PRIMARY KEY
            CHECK (sku GLOB '[0-9][0-9][0-9][0-9][0-9]'),
  issued_at TEXT NOT NULL,
  label     TEXT NOT NULL DEFAULT '',
  fate      TEXT NOT NULL DEFAULT 'issued'
            CHECK (fate IN ('issued','sold','voided','hard-deleted','retired'))
);

CREATE TRIGGER IF NOT EXISTS sku_ledger_no_delete
BEFORE DELETE ON sku_ledger
BEGIN
  SELECT RAISE(ABORT, 'a SKU is never freed');
END;

-- The number and the date it was issued are facts. Only the fate moves.
CREATE TRIGGER IF NOT EXISTS sku_ledger_no_rewrite
BEFORE UPDATE ON sku_ledger
WHEN NEW.sku <> OLD.sku OR NEW.issued_at <> OLD.issued_at
BEGIN
  SELECT RAISE(ABORT, 'a SKU and its issue date cannot change');
END;

-- One row per physical thing. There is deliberately no quantity column.
CREATE TABLE IF NOT EXISTS units (
  id                     INTEGER PRIMARY KEY,
  sku                    TEXT NOT NULL UNIQUE REFERENCES sku_ledger(sku),
  brand                  TEXT NOT NULL DEFAULT '',
  model                  TEXT NOT NULL DEFAULT '',
  title                  TEXT NOT NULL DEFAULT '',
  category               TEXT,
  condition              TEXT,
  test_status            TEXT,
  location               TEXT,
  mfr_serial             TEXT,
  defect_notes           TEXT,
  upc                    TEXT,
  lot                    TEXT,
  acquisition_cost_cents INTEGER CHECK (acquisition_cost_cents IS NULL OR acquisition_cost_cents >= 0),
  msrp_cents             INTEGER CHECK (msrp_cents  IS NULL OR msrp_cents  >= 0),
  ask_cents              INTEGER CHECK (ask_cents   IS NULL OR ask_cents   >= 0),
  floor_cents            INTEGER CHECK (floor_cents IS NULL OR floor_cents >= 0),
  state                  TEXT NOT NULL DEFAULT 'available'
                         CHECK (state IN ('available','reserved','repair','sold','voided','scrapped','lost')),
  received_at            TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_units_state ON units(state);
CREATE INDEX IF NOT EXISTS ix_units_brand_model ON units(brand, model);

-- A sale is an event that happened, not a mutable row. It is voided, never
-- edited and never deleted.
CREATE TABLE IF NOT EXISTS sales (
  id             INTEGER PRIMARY KEY,
  sku            TEXT NOT NULL REFERENCES sku_ledger(sku),
  price_cents    INTEGER NOT NULL CHECK (price_cents >= 0),
  channel        TEXT NOT NULL,
  payment_method TEXT,
  customer_name  TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  note           TEXT,
  sold_at        TEXT NOT NULL,
  receipt_no     TEXT NOT NULL UNIQUE,
  voided_at      TEXT,
  void_reason    TEXT
);

-- ===========================================================================
-- The single most important line in this application.
-- A unit has at most one sale that has not been voided. Two concurrent sales
-- of the same SKU cannot be written, so they cannot happen.
-- ===========================================================================
CREATE UNIQUE INDEX IF NOT EXISTS ux_one_live_sale_per_sku
  ON sales(sku) WHERE voided_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_sales_sold_at ON sales(sold_at);

-- Belt to the index's braces: refuse the insert if the thing is not sellable,
-- so state and sales can never disagree with each other.
CREATE TRIGGER IF NOT EXISTS sales_unit_must_be_sellable
BEFORE INSERT ON sales
WHEN (SELECT state FROM units WHERE sku = NEW.sku) IS NULL
  OR (SELECT state FROM units WHERE sku = NEW.sku) NOT IN ('available','reserved')
BEGIN
  SELECT RAISE(ABORT, 'that unit is not available to sell');
END;

CREATE TRIGGER IF NOT EXISTS sales_no_delete
BEFORE DELETE ON sales
BEGIN
  SELECT RAISE(ABORT, 'a sale is voided, never deleted');
END;

-- Voiding is the only permitted change.
CREATE TRIGGER IF NOT EXISTS sales_immutable
BEFORE UPDATE ON sales
WHEN NEW.sku         <> OLD.sku
  OR NEW.price_cents <> OLD.price_cents
  OR NEW.sold_at     <> OLD.sold_at
  OR NEW.channel     <> OLD.channel
  OR NEW.receipt_no  <> OLD.receipt_no
BEGIN
  SELECT RAISE(ABORT, 'a completed sale cannot be edited, only voided');
END;

CREATE TRIGGER IF NOT EXISTS sales_no_unvoid
BEFORE UPDATE ON sales
WHEN OLD.voided_at IS NOT NULL AND NEW.voided_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a voided sale stays voided');
END;

-- 'sold' is a claim about the sales table, so make it check.
CREATE TRIGGER IF NOT EXISTS units_sold_needs_a_sale
BEFORE UPDATE OF state ON units
WHEN NEW.state = 'sold'
 AND NOT EXISTS (SELECT 1 FROM sales WHERE sku = NEW.sku AND voided_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'cannot mark sold without a sale');
END;

CREATE TRIGGER IF NOT EXISTS units_sold_stays_sold
BEFORE UPDATE OF state ON units
WHEN OLD.state = 'sold' AND NEW.state <> 'sold'
 AND EXISTS (SELECT 1 FROM sales WHERE sku = OLD.sku AND voided_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'void the sale before changing this unit');
END;

CREATE TRIGGER IF NOT EXISTS units_no_delete_while_sold
BEFORE DELETE ON units
WHEN EXISTS (SELECT 1 FROM sales WHERE sku = OLD.sku AND voided_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'void the sale before deleting this unit');
END;

-- Append-only audit. Keyed by SKU, not by row id, so it outlives the unit.
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY,
  at        TEXT NOT NULL,
  sku       TEXT REFERENCES sku_ledger(sku),
  kind      TEXT NOT NULL,
  field     TEXT,
  old_value TEXT,
  new_value TEXT,
  actor     TEXT NOT NULL DEFAULT 'floor',
  note      TEXT
);

CREATE INDEX IF NOT EXISTS ix_events_sku_at ON events(sku, at);

CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'history is never rewritten');
END;

CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'history is never deleted');
END;

-- Photos live as files; this is the index over them.
CREATE TABLE IF NOT EXISTS photos (
  id         INTEGER PRIMARY KEY,
  sku        TEXT NOT NULL REFERENCES sku_ledger(sku),
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_photos_sku ON photos(sku);

-- Everything the business calls things. No vocabulary is compiled in.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Seed lists. These are examples, not a schema — every one is editable in the
 * app, and none of them mention appliances.
 */
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  storeName: "Floor",
  skuStart: 10000,
  taxRateBps: 0,
  currency: "USD",
  categories: ["Uncategorized"],
  conditions: ["New", "Open box", "Excellent", "Good", "Fair", "For parts"],
  testStatuses: ["untested", "passed", "failed", "partial"],
  locations: ["Floor", "Back room", "Repair bench"],
  channels: ["floor", "ebay", "facebook", "offerup", "wholesale"],
  paymentMethods: ["cash", "card", "other"],
};
