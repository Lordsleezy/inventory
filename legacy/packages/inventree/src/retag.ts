import { isSku } from "@floor/domain";
import { InventreeClient, InventreeError } from "./client.ts";
import { recordId } from "./list.ts";
import type { InventreeStock } from "./map-unit.ts";
import { loadUnitBySku } from "./units.ts";

export async function retagSku(
  client: InventreeClient,
  input: { sku: string; nextSku: string; actor: string },
) {
  if (!isSku(input.nextSku)) throw Object.assign(new Error("SKU must be five digits"), { status: 400 });
  if (input.nextSku === input.sku) {
    const same = await loadUnitBySku(client, input.sku);
    if (!same) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
    return same;
  }
  const stocks = await client.listAll<InventreeStock>(
    `/api/stock/?serial=${encodeURIComponent(input.sku)}`,
  );
  const stock = stocks.find((row) => row.serial === input.sku);
  if (!stock) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  try {
    await client.patch(`/api/stock/${recordId(stock)}/`, {
      serial: input.nextSku,
      notes: `SKU ${input.sku} → ${input.nextSku} by ${input.actor}`,
    });
  } catch (err) {
    if (err instanceof InventreeError && err.status === 400) {
      throw Object.assign(new Error(`SKU ${input.nextSku} already exists`), { status: 409, body: err.body });
    }
    throw err;
  }
  const unit = await loadUnitBySku(client, input.nextSku);
  if (!unit) throw new Error(`SKU changed to ${input.nextSku} but could not be reloaded`);
  return unit;
}
