import { statusForFloorState } from "./status.ts";
import { stockMetadataPath } from "./paths.ts";
import { emptyEnvelope, META_KEY } from "./metadata.ts";
import { InventreeClient } from "./client.ts";
import { recordId } from "./list.ts";
import { readEnvelope, type InventreeStock } from "./map-unit.ts";
import { loadUnitBySku } from "./units.ts";

export async function voidUnit(
  client: InventreeClient,
  input: { sku: string; reason: string; actor: string },
) {
  const reason = input.reason.trim();
  if (!reason) throw Object.assign(new Error("Void requires a reason"), { status: 400 });
  const stocks = await client.listAll<InventreeStock>(
    `/api/stock/?serial=${encodeURIComponent(input.sku)}`,
  );
  const stock = stocks.find((row) => row.serial === input.sku);
  if (!stock) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  const unit = await loadUnitBySku(client, input.sku);
  if (unit?.state === "sold") {
    throw Object.assign(new Error("Sold units cannot be voided. Return the unit first."), { status: 409 });
  }
  const current = readEnvelope(stock);
  const next = {
    ...emptyEnvelope(),
    ...current.value,
    voided: { reason, at: new Date().toISOString(), by: input.actor },
  };
  await client.patch(`/api/stock/${recordId(stock)}/`, {
    status: statusForFloorState("voided"),
    notes: `Void ${input.sku}: ${reason} (${input.actor})`,
  });
  await client.patch(stockMetadataPath(recordId(stock)), {
    metadata: { [META_KEY]: next },
  });
  const after = await loadUnitBySku(client, input.sku);
  if (!after) throw new Error("Void saved but unit could not be reloaded");
  return after;
}
