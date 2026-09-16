import { stockMetadataPath, partMetadataPath } from "./paths.ts";
import { filterUnits, isSku, type Unit, type UnitQuery } from "@floor/domain";
import { InventreeClient } from "./client.ts";
import { recordId } from "./list.ts";
import { META_KEY } from "./metadata.ts";
import { stockListToUnits, type InventreeStock } from "./map-unit.ts";

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

async function attachMetadata(client: InventreeClient, stock: InventreeStock): Promise<InventreeStock> {
  if (stock.metadata && typeof stock.metadata === "object" && META_KEY in stock.metadata) return stock;
  try {
    const wrapped = await client.get<{ metadata?: Record<string, unknown> }>(stockMetadataPath(recordId(stock)));
    return { ...stock, metadata: wrapped.metadata ?? wrapped };
  } catch {
    return stock;
  }
}

async function attachPartMetadata(
  client: InventreeClient,
  stock: InventreeStock,
  cache: Map<number, Record<string, unknown>>,
): Promise<InventreeStock> {
  const partId = stock.part_detail?.pk ?? stock.part;
  if (!partId) return stock;
  if (stock.part_detail?.metadata && cache.get(partId) === undefined) {
    cache.set(partId, stock.part_detail.metadata as Record<string, unknown>);
  }
  let metadata = cache.get(partId);
  if (!metadata) {
    try {
      const wrapped = await client.get<{ metadata?: Record<string, unknown> }>(partMetadataPath(partId));
      metadata = (wrapped.metadata ?? wrapped) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    cache.set(partId, metadata);
  }
  return {
    ...stock,
    part_detail: { ...stock.part_detail, pk: partId, metadata },
  };
}

async function attachAttachments(
  client: InventreeClient,
  stocks: InventreeStock[],
): Promise<InventreeStock[]> {
  const atts = await client.listAll<{ pk: number; model_id?: number }>(
    "/api/attachment/?model_type=stockitem",
  );
  const byModel = new Map<number, { pk: number }[]>();
  for (const att of atts) {
    if (typeof att.model_id !== "number") continue;
    const list = byModel.get(att.model_id) ?? [];
    list.push({ pk: att.pk });
    byModel.set(att.model_id, list);
  }
  return stocks.map((stock) => ({
    ...stock,
    attachments: byModel.get(recordId(stock)) ?? [],
  }));
}

export async function loadUnits(client: InventreeClient): Promise<Unit[]> {
  const stocks = await client.listAll<InventreeStock>("/api/stock/?part_detail=true&location_detail=true");
  const serialized = stocks.filter((row) => row.serial);
  const partCache = new Map<number, Record<string, unknown>>();
  const withMeta = await mapPool(serialized, 4, async (row) =>
    attachPartMetadata(client, await attachMetadata(client, row), partCache),
  );
  return stockListToUnits(await attachAttachments(client, withMeta));
}

export async function loadUnitBySku(client: InventreeClient, sku: string): Promise<Unit | null> {
  if (!isSku(sku)) return null;
  const stocks = await client.listAll<InventreeStock>(
    `/api/stock/?serial=${encodeURIComponent(sku)}&part_detail=true&location_detail=true`,
  );
  const match = stocks.find((row) => row.serial === sku);
  if (!match) return null;
  const partCache = new Map<number, Record<string, unknown>>();
  const withMeta = await attachPartMetadata(client, await attachMetadata(client, match), partCache);
  const [withAtts] = await attachAttachments(client, [withMeta]);
  const mapped = stockListToUnits([withAtts])[0] ?? null;
  if (!mapped) return null;
  const partId = withAtts.part_detail?.pk ?? withAtts.part;
  if (!partId) return { ...mapped, sharedModelCount: 1 };
  const siblings = await client.listAll<{ serial?: string | null }>(`/api/stock/?part=${partId}`);
  return { ...mapped, sharedModelCount: siblings.filter((row) => row.serial).length };
}

export async function searchUnits(client: InventreeClient, query: UnitQuery): Promise<Unit[]> {
  return filterUnits(await loadUnits(client), query);
}
