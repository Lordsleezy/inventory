/** Minimal database surface. Implemented by node:sqlite in tests and by
 *  @capacitor-community/sqlite on the phone. Async because the phone is. */
export type SqlValue = string | number | null;

export interface Db {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number; lastId: number }>;
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** BEGIN IMMEDIATE / COMMIT / ROLLBACK around fn. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type FloorErrorCode =
  | "sku_taken"
  | "already_sold"
  | "not_sellable"
  | "not_found"
  | "immutable"
  | "invalid";

export class FloorError extends Error {
  code: FloorErrorCode;

  constructor(message: string, code: FloorErrorCode) {
    super(message);
    this.name = "FloorError";
    this.code = code;
  }
}

/** SQLite reports our guarantees as constraint failures. Turn them into
 *  sentences a person on a shop floor can act on. */
export function translateDbError(err: unknown, context: { sku?: string } = {}): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const sku = context.sku ? `SKU ${context.sku}` : "That unit";

  if (/ux_one_live_sale_per_sku/.test(raw)) {
    return new FloorError(`${sku} has already been sold.`, "already_sold");
  }
  if (/not available to sell/.test(raw)) {
    return new FloorError(`${sku} is not available to sell.`, "not_sellable");
  }
  if (/a SKU is never freed/.test(raw)) {
    return new FloorError("A SKU is never freed once issued.", "immutable");
  }
  if (/sku_ledger\.sku|UNIQUE constraint failed: sku_ledger/.test(raw)) {
    return new FloorError(`${sku} was already used and cannot be reissued.`, "sku_taken");
  }
  if (/UNIQUE constraint failed: units\.sku/.test(raw)) {
    return new FloorError(`${sku} is already in inventory.`, "sku_taken");
  }
  if (/history is never (rewritten|deleted)/.test(raw)) {
    return new FloorError("History cannot be changed.", "immutable");
  }
  if (/only voided|never deleted|stays voided|cannot change/.test(raw)) {
    return new FloorError(raw.replace(/^.*?:\s*/, ""), "immutable");
  }
  if (/void the sale before/.test(raw)) {
    return new FloorError("Void the sale first.", "already_sold");
  }
  if (/cannot mark sold without a sale/.test(raw)) {
    return new FloorError("A unit cannot be marked sold without a sale.", "invalid");
  }
  return err instanceof Error ? err : new Error(raw);
}
