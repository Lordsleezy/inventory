import type { Db, SqlValue } from "./db.ts";
import { centsToInput } from "./money.ts";

function cell(value: SqlValue | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(headers: string[], rows: (SqlValue | undefined)[][]): string {
  const lines = [headers.map(cell).join(",")];
  for (const row of rows) lines.push(row.map(cell).join(","));
  // CRLF so Excel on any platform opens it without a wizard.
  return `${lines.join("\r\n")}\r\n`;
}

const UNIT_HEADERS = [
  "sku",
  "brand",
  "model",
  "description",
  "category",
  "condition",
  "test_status",
  "location",
  "mfr_serial",
  "upc",
  "lot",
  "cost",
  "msrp",
  "ask",
  "floor",
  "state",
  "received_at",
  "updated_at",
  "defect_notes",
];

export async function unitsCsv(db: Db): Promise<string> {
  const rows = await db.all<Record<string, SqlValue>>(
    "SELECT * FROM units ORDER BY CAST(sku AS INTEGER)",
  );
  return toCsv(
    UNIT_HEADERS,
    rows.map((r) => [
      r.sku,
      r.brand,
      r.model,
      r.title,
      r.category,
      r.condition,
      r.test_status,
      r.location,
      r.mfr_serial,
      r.upc,
      r.lot,
      centsToInput(r.acquisition_cost_cents as number | null),
      centsToInput(r.msrp_cents as number | null),
      centsToInput(r.ask_cents as number | null),
      centsToInput(r.floor_cents as number | null),
      r.state,
      r.received_at,
      r.updated_at,
      r.defect_notes,
    ]),
  );
}

const SALE_HEADERS = [
  "receipt_no",
  "sku",
  "brand",
  "model",
  "price",
  "channel",
  "payment_method",
  "customer_name",
  "customer_phone",
  "sold_at",
  "voided_at",
  "void_reason",
];

export async function salesCsv(db: Db): Promise<string> {
  const rows = await db.all<Record<string, SqlValue>>(
    `SELECT s.*, u.brand AS brand, u.model AS model
       FROM sales s LEFT JOIN units u ON u.sku = s.sku
      ORDER BY s.sold_at DESC`,
  );
  return toCsv(
    SALE_HEADERS,
    rows.map((r) => [
      r.receipt_no,
      r.sku,
      r.brand,
      r.model,
      centsToInput(r.price_cents as number),
      r.channel,
      r.payment_method,
      r.customer_name,
      r.customer_phone,
      r.sold_at,
      r.voided_at,
      r.void_reason,
    ]),
  );
}

export async function historyCsv(db: Db): Promise<string> {
  const rows = await db.all<Record<string, SqlValue>>(
    "SELECT * FROM events ORDER BY id",
  );
  return toCsv(
    ["at", "sku", "kind", "field", "old_value", "new_value", "actor", "note"],
    rows.map((r) => [r.at, r.sku, r.kind, r.field, r.old_value, r.new_value, r.actor, r.note]),
  );
}

export async function skuLedgerCsv(db: Db): Promise<string> {
  const rows = await db.all<Record<string, SqlValue>>(
    "SELECT * FROM sku_ledger ORDER BY CAST(sku AS INTEGER)",
  );
  return toCsv(
    ["sku", "issued_at", "label", "fate"],
    rows.map((r) => [r.sku, r.issued_at, r.label, r.fate]),
  );
}
