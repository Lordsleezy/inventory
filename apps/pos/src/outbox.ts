export type OutboxStatus = "pending" | "synced" | "incident";

export type OutboxRow = {
  id: string;
  sku: string;
  priceCents: number;
  taxCents: number;
  actorId: string;
  clientSaleId: string;
  createdAt: string;
  receiptPayload: string;
  status: OutboxStatus;
  receiptNo: string | null;
  error: string | null;
};

export type SyncDeps = {
  reserve: (sku: string, channel: string) => Promise<{ id: string }>;
  finalize: (args: {
    sku: string;
    channel: string;
    priceCents: number;
    paymentMethod: string;
    paymentId: string | null;
    reservationId: string;
    taxCents: number;
  }) => Promise<{ receipt_no?: string; receiptNo?: string } | null | undefined>;
  release: (id: string) => Promise<void>;
};

export type SyncResult =
  | { kind: "synced"; receiptNo: string }
  | { kind: "incident"; message: string }
  | { kind: "retry"; message: string };

export function isDoubleSellFailure(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /double_sell|unit_not_sellable|already has a live sale|23505/i.test(text);
}

export async function syncOutboxRow(row: OutboxRow, deps: SyncDeps): Promise<SyncResult> {
  if (row.status !== "pending") {
    return { kind: "retry", message: "not pending" };
  }
  let hold: string | null = null;
  try {
    const reserved = await deps.reserve(row.sku, "floor");
    hold = reserved.id;
    const sale = await deps.finalize({
      sku: row.sku,
      channel: "floor",
      priceCents: row.priceCents,
      paymentMethod: "cash",
      paymentId: row.clientSaleId,
      reservationId: hold,
      taxCents: row.taxCents,
    });
    const receiptNo = sale?.receipt_no || sale?.receiptNo || "";
    if (!receiptNo) return { kind: "retry", message: "finalize returned no receipt" };
    return { kind: "synced", receiptNo };
  } catch (err) {
    if (hold) {
      try {
        await deps.release(hold);
      } catch {
        /* already released */
      }
    }
    if (isDoubleSellFailure(err)) {
      return {
        kind: "incident",
        message: `INCIDENT — cash taken for SKU ${row.sku}, unit is not ours. Do not retry. Refund the customer or recover the unit.`,
      };
    }
    return { kind: "retry", message: err instanceof Error ? err.message : String(err) };
  }
}
