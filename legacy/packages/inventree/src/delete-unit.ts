import { isListedAnywhere } from "@floor/domain";
import { InventreeClient } from "./client.ts";
import { recordId } from "./list.ts";
import { floorLog } from "./log.ts";
import { withDeleteSerializedAllowed } from "./settings-guard.ts";
import { loadUnitBySku } from "./units.ts";
import type { InventreeStock } from "./map-unit.ts";

export async function hardDeleteUnit(
  client: InventreeClient,
  input: { sku: string; typedSku: string; actor: string },
) {
  if (input.typedSku !== input.sku) {
    throw Object.assign(new Error("Type the SKU to confirm delete"), { status: 400 });
  }
  const unit = await loadUnitBySku(client, input.sku);
  if (!unit) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  if (unit.state === "sold" || unit.sale) {
    throw Object.assign(new Error("Cannot hard-delete a unit that was sold"), { status: 409 });
  }
  if (isListedAnywhere(unit)) {
    throw Object.assign(new Error("Cannot hard-delete a unit that has been listed"), { status: 409 });
  }
  const stocks = await client.listAll<InventreeStock>(
    `/api/stock/?serial=${encodeURIComponent(input.sku)}`,
  );
  const stock = stocks.find((row) => row.serial === input.sku);
  if (!stock) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  if (stock.sales_order) {
    throw Object.assign(new Error("Cannot hard-delete a unit with sales-order history"), { status: 409 });
  }
  floorLog("hard_delete", { sku: input.sku, actor: input.actor, stockId: recordId(stock) });
  await withDeleteSerializedAllowed(client, async () => {
    await client.delete(`/api/stock/${recordId(stock)}/`);
  });
  const leftover = await loadUnitBySku(client, input.sku);
  if (leftover) throw new Error(`Hard delete of ${input.sku} did not remove the unit`);
}
