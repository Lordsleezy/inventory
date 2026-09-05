import { partMetadataPath } from "./paths.ts";
import { META_KEY } from "./metadata.ts";
import { InventreeClient } from "./client.ts";
import { recordId } from "./list.ts";
import type { InventreeStock } from "./map-unit.ts";
import { loadUnitBySku } from "./units.ts";

export type PartEditInput = {
  sku: string;
  brand: string;
  model: string;
  title: string;
  category: string;
  upc: string;
  actor: string;
};

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

export async function countUnitsForPart(client: InventreeClient, partId: number): Promise<number> {
  const rows = await client.listAll<{ serial?: string | null }>(`/api/stock/?part=${partId}`);
  return rows.filter((row) => row.serial).length;
}

export async function updatePartFields(client: InventreeClient, input: PartEditInput) {
  const model = input.model.trim();
  if (!model) throw Object.assign(new Error("Model is required"), { status: 400 });
  const stocks = await client.listAll<InventreeStock>(
    `/api/stock/?serial=${encodeURIComponent(input.sku)}&part_detail=true`,
  );
  const stock = stocks.find((row) => row.serial === input.sku);
  if (!stock) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  const partId = stock.part ?? stock.part_detail?.pk;
  if (!partId) throw Object.assign(new Error("Item is missing a model record"), { status: 500 });
  const shared = await countUnitsForPart(client, partId);
  const categoryId = await findCategory(client, input.category);
  const brand = input.brand.trim();
  const title = input.title.trim();
  const upc = input.upc.trim();
  let partMeta: Record<string, unknown> = {};
  try {
    const wrapped = await client.get<{ metadata?: Record<string, unknown> }>(partMetadataPath(partId));
    partMeta = (wrapped.metadata ?? wrapped) as Record<string, unknown>;
  } catch {
    partMeta = {};
  }
  const prevLros =
    partMeta[META_KEY] && typeof partMeta[META_KEY] === "object"
      ? (partMeta[META_KEY] as Record<string, unknown>)
      : {};
  await client.patch(`/api/part/${partId}/`, {
    name: [brand, model].filter(Boolean).join(" ") || model,
    IPN: model,
    description: title || model,
    ...(categoryId ? { category: categoryId } : {}),
  });
  await client.patch(partMetadataPath(partId), {
    metadata: { [META_KEY]: { ...prevLros, brand, upc } },
  });
  const audit = [
    `Part edit ${input.sku} by ${input.actor}`,
    `brand=${brand}`,
    `model=${model}`,
    `title=${title}`,
    `category=${input.category.trim()}`,
    `upc=${upc}`,
    `sharedUnits=${shared}`,
  ].join(" | ");
  await client.patch(`/api/stock/${recordId(stock)}/`, { notes: audit });
  const unit = await loadUnitBySku(client, input.sku);
  if (!unit) throw new Error("Part saved but unit could not be reloaded");
  return unit;
}
