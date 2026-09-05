import {
  moneyStringToCents,
  type Unit,
} from "@floor/domain";
import { emptyEnvelope, mergeListings, LrosEnvelope, META_KEY } from "./metadata.ts";
import { floorStateFromStatus } from "./status.ts";

export type InventreeStock = {
  pk: number;
  serial: string | null;
  batch: string | null;
  purchase_price: string | null;
  status: { label?: string; value?: number } | number | string;
  location?: number | null;
  location_detail?: { pathstring?: string; name?: string } | null;
  part?: number;
  part_detail?: {
    pk?: number;
    name?: string;
    IPN?: string;
    description?: string;
    category_detail?: { name?: string };
    metadata?: Record<string, unknown> | null;
  };
  metadata?: Record<string, unknown> | null;
  allocated?: boolean | number | null;
  sales_order?: number | null;
  customer?: number | null;
  in_stock?: boolean | null;
  creation_date?: string | null;
  attachments?: { pk: number }[];
};

export { STOCK_STATUS, statusCodeOf, floorStateFromStatus, statusForFloorState } from "./status.ts";

export type EnvelopeResult =
  | { ok: true; value: LrosEnvelope }
  | { ok: false; error: string; value: LrosEnvelope };

export function readEnvelope(stock: InventreeStock): EnvelopeResult {
  const raw = stock.metadata?.[META_KEY];
  if (raw === undefined || raw === null) {
    return { ok: true, value: emptyEnvelope() };
  }
  const parsed = LrosEnvelope.safeParse(raw);
  if (parsed.success) {
    return { ok: true, value: { ...parsed.data, listings: mergeListings(parsed.data.listings) } };
  }
  return {
    ok: false,
    error: `corrupt lros metadata: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    value: emptyEnvelope(),
  };
}

function partLros(stock: InventreeStock): { brand: string; upc: string } {
  const meta = stock.part_detail?.metadata as { lros?: { brand?: unknown; upc?: unknown } } | undefined;
  const brand = meta?.lros?.brand;
  const upc = meta?.lros?.upc;
  return {
    brand: typeof brand === "string" ? brand : "",
    upc: typeof upc === "string" ? upc : "",
  };
}

function blankUnit(sku: string, recordError: string): Unit {
  const env = emptyEnvelope();
  return {
    sku,
    stockId: null,
    brand: "",
    model: "",
    title: "",
    category: "",
    upc: "",
    sharedModelCount: 1,
    location: null,
    lot: null,
    state: "repair",
    condition: null,
    testStatus: "untested",
    defectNotes: null,
    mfrSerial: null,
    acquisitionCostCents: null,
    msrpCents: null,
    retail: env.retail,
    askCents: null,
    floorCents: null,
    listings: env.listings,
    sale: null,
    voided: null,
    photoCount: 0,
    primaryAttachmentId: null,
    receivedOn: "",
    recordError,
  };
}

export function stockToUnit(stock: InventreeStock): Unit {
  const sku = stock.serial && /^\d{5}$/.test(stock.serial) ? stock.serial : stock.serial || `pk-${stock.pk}`;
  const skuError = stock.serial && /^\d{5}$/.test(stock.serial) ? null : `missing 5-digit SKU (serial=${stock.serial ?? "null"}, pk=${stock.pk})`;

  const envelope = readEnvelope(stock);
  const env = envelope.value;
  const allocated = Boolean(stock.sales_order || stock.allocated);
  const shippedOut = stock.in_stock === false && Boolean(stock.sales_order || stock.customer);
  const mapped = env.sale || shippedOut
    ? { state: "sold" as const, error: null }
    : floorStateFromStatus(stock.status, allocated);
  const part = stock.part_detail ?? {};
  const loc = stock.location_detail;

  let acquisitionCostCents: number | null = null;
  try {
    acquisitionCostCents = moneyStringToCents(stock.purchase_price);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return blankUnit(sku, `bad purchase_price: ${message}`);
  }

  const recordError = [skuError, envelope.ok ? null : envelope.error, mapped.error]
    .filter((part): part is string => Boolean(part))
    .join(" | ") || null;

  return {
    sku,
    stockId: stock.pk,
    brand: partLros(stock).brand,
    model: part.IPN ?? "",
    title: part.description ?? part.name ?? "",
    category: part.category_detail?.name ?? "",
    upc: partLros(stock).upc,
    sharedModelCount: 1,
    location: loc?.pathstring ?? loc?.name ?? null,
    lot: stock.batch || null,
    state: recordError && mapped.state === "available" ? "repair" : mapped.state,
    condition: env.condition,
    testStatus: env.testStatus,
    defectNotes: env.defectNotes,
    mfrSerial: env.mfrSerial,
    acquisitionCostCents,
    msrpCents: env.msrpCents,
    retail: env.retail,
    askCents: env.askCents,
    floorCents: env.floorCents,
    listings: env.listings,
    sale: env.sale,
    voided: env.voided ?? null,
    photoCount: stock.attachments?.length ?? 0,
    primaryAttachmentId: env.primaryAttachmentId ?? null,
    receivedOn: stock.creation_date ?? "",
    recordError,
  };
}

export function stockListToUnits(stocks: InventreeStock[]): Unit[] {
  return stocks.map((stock) => {
    try {
      return stockToUnit(stock);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return blankUnit(
        stock.serial || `pk-${stock.pk}`,
        `unit mapping failed: ${message}`,
      );
    }
  });
}
