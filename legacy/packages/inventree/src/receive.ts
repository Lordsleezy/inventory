import { centsToMoneyString, isSku, rejectUsedSku, type Cents, type SkuLedgerEntry } from "@floor/domain";
import { partMetadataPath, stockMetadataPath } from "./paths.ts";
import { InventreeClient, InventreeError } from "./client.ts";
import { recordId } from "./list.ts";
import { emptyEnvelope, META_KEY } from "./metadata.ts";
import { nextSku } from "./sku.ts";
import { loadUnitBySku } from "./units.ts";
import type { InventreeStock } from "./map-unit.ts";

export type ReceiveInput = {
  brand: string;
  model: string;
  title: string;
  category: string;
  lot: string | null;
  acquisitionCostCents: Cents | null;
  askCents?: Cents | null;
  msrpCents?: Cents | null;
  location?: string | null;
  skuStart: number;
  sku?: string;
  copyFromSku?: string;
  occupied?: SkuLedgerEntry[];
};

export type ModelHint = {
  sku: string;
  brand: string;
  model: string;
  title: string;
  category: string;
};

function createdStock(created: unknown): { pk?: number; id?: number } {
  if (Array.isArray(created)) return created[0] as { pk?: number; id?: number };
  return created as { pk?: number; id?: number };
}

async function findCategory(client: InventreeClient, name: string): Promise<number | null> {
  if (!name.trim()) return null;
  const rows = await client.listAll<{ pk?: number; id?: number; name?: string }>(
    `/api/part/category/?search=${encodeURIComponent(name.trim())}`,
  );
  const exact = rows.find((row) => row.name === name.trim());
  if (exact) return recordId(exact);
  const made = await client.post<{ pk?: number; id?: number }>("/api/part/category/", {
    name: name.trim(),
  });
  return recordId(made);
}

async function findPartByModel(client: InventreeClient, model: string) {
  const rows = await client.listAll<{ pk?: number; id?: number; IPN?: string }>(
    `/api/part/?IPN=${encodeURIComponent(model)}`,
  );
  return rows.find((row) => row.IPN === model) ?? null;
}

export async function descriptiveHintForModel(client: InventreeClient, model: string): Promise<ModelHint | null> {
  if (!model.trim()) return null;
  const stocks = await client.listAll<InventreeStock>(
    `/api/stock/?part_detail=true&limit=50`,
  );
  const match = stocks.find((row) => row.part_detail?.IPN === model.trim() && row.serial && isSku(row.serial));
  if (!match?.serial) return null;
  const unit = await loadUnitBySku(client, match.serial);
  if (!unit) return null;
  return {
    sku: unit.sku,
    brand: unit.brand,
    model: unit.model,
    title: unit.title,
    category: unit.category,
  };
}

async function findOrCreateLocation(client: InventreeClient, name: string | null): Promise<number | null> {
  if (!name?.trim()) return null;
  const rows = await client.listAll<{ pk?: number; id?: number; name?: string }>(
    `/api/stock/location/?search=${encodeURIComponent(name.trim())}`,
  );
  const exact = rows.find((row) => row.name === name.trim());
  if (exact) return recordId(exact);
  const made = await client.post<{ pk?: number; id?: number }>("/api/stock/location/", { name: name.trim() });
  return recordId(made);
}

export async function receiveUnit(client: InventreeClient, input: ReceiveInput) {
  const model = input.model.trim();
  const brand = input.brand.trim();
  const title = input.title.trim();
  const category = input.category.trim();
  if (!model) throw Object.assign(new Error("Model is required"), { status: 400 });

  let sku = input.sku;
  if (sku) {
    if (!isSku(sku)) throw Object.assign(new Error("SKU must be five digits"), { status: 400 });
  } else {
    sku = await nextSku(client, input.skuStart, (input.occupied ?? []).map((row) => row.sku));
  }
  if (input.occupied) {
    rejectUsedSku({ entries: Object.fromEntries(input.occupied.map((row) => [row.sku, row])) }, sku);
  }

  const categoryId = await findCategory(client, category);
  let part = await findPartByModel(client, model);
  if (!part) {
    part = await client.post("/api/part/", {
      name: [brand, model].filter(Boolean).join(" ") || model,
      IPN: model,
      description: title || model,
      active: true,
      trackable: true,
      purchaseable: true,
      salable: true,
      ...(categoryId ? { category: categoryId } : {}),
    });
  }
  const partId = recordId(part);
  await client.patch(partMetadataPath(partId), {
    metadata: { [META_KEY]: { brand } },
  });
  if (title) {
    await client.patch(`/api/part/${partId}/`, { description: title, name: [brand, model].filter(Boolean).join(" ") || model });
  }

  let created;
  try {
    created = await client.post("/api/stock/", {
      part: partId,
      quantity: 1,
      serial_numbers: sku,
      batch: input.lot || "",
      purchase_price: centsToMoneyString(input.acquisitionCostCents),
    });
  } catch (err) {
    if (err instanceof InventreeError && err.status === 400) {
      throw Object.assign(new Error(`SKU ${sku} already exists`), { status: 409, body: err.body });
    }
    throw err;
  }

  const stockId = recordId(createdStock(created));
  const locationId = await findOrCreateLocation(client, input.location ?? null);
  if (locationId) {
    await client.patch(`/api/stock/${stockId}/`, { location: locationId });
  }
  await client.patch(stockMetadataPath(stockId), {
    metadata: { [META_KEY]: { ...emptyEnvelope(), askCents: input.askCents ?? null, msrpCents: input.msrpCents ?? null } },
  });
  const unit = await loadUnitBySku(client, sku);
  if (!unit) throw new Error(`Received ${sku} but could not read it back`);
  return unit;
}
