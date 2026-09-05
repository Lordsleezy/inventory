import { stockMetadataPath } from "./paths.ts";
import { emptyEnvelope, META_KEY } from "./metadata.ts";
import { InventreeClient } from "./client.ts";
import { recordId } from "./list.ts";
import { readEnvelope, type InventreeStock } from "./map-unit.ts";
import { loadUnitBySku } from "./units.ts";
import type { Cents } from "@floor/domain";

export type PriceInput = {
  sku: string;
  msrpCents: Cents | null;
  retailCents: Cents | null;
  retailer: string | null;
  capturedOn: string | null;
  askCents: Cents | null;
  floorCents: Cents | null;
  actor: string;
  role: "admin" | "staff";
};

export async function priceUnit(client: InventreeClient, input: PriceInput) {
  const stocks = await client.listAll<InventreeStock>(
    `/api/stock/?serial=${encodeURIComponent(input.sku)}`,
  );
  const stock = stocks.find((row) => row.serial === input.sku);
  if (!stock) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  const current = readEnvelope(stock);
  const next = {
    ...emptyEnvelope(),
    ...current.value,
    msrpCents: input.msrpCents,
    retail: {
      cents: input.retailCents,
      retailer: input.retailer,
      capturedOn: input.capturedOn,
    },
    askCents: input.askCents,
    floorCents: input.role === "admin" ? input.floorCents : current.value.floorCents,
  };
  await client.patch(`/api/stock/${recordId(stock)}/`, {
    notes: `Price ${input.sku} by ${input.actor}`,
  });
  await client.patch(stockMetadataPath(recordId(stock)), {
    metadata: { [META_KEY]: next },
  });
  const unit = await loadUnitBySku(client, input.sku);
  if (!unit) throw new Error("Price saved but unit could not be reloaded");
  return unit;
}
