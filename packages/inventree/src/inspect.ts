import { stockMetadataPath } from "./paths.ts";
import { emptyEnvelope, META_KEY } from "./metadata.ts";
import { InventreeClient } from "./client.ts";
import { recordId } from "./list.ts";
import { readEnvelope, type InventreeStock } from "./map-unit.ts";
import { loadUnitBySku } from "./units.ts";

export type InspectInput = {
  sku: string;
  condition: string | null;
  testStatus: string;
  defectNotes: string | null;
  mfrSerial: string | null;
  location?: string | null;
  actor: string;
};

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

export async function inspectUnit(client: InventreeClient, input: InspectInput) {
  const stocks = await client.listAll<InventreeStock>(
    `/api/stock/?serial=${encodeURIComponent(input.sku)}&part_detail=true`,
  );
  const stock = stocks.find((row) => row.serial === input.sku);
  if (!stock) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  const id = recordId(stock);
  let metadata: Record<string, unknown> | null = stock.metadata ?? null;
  try {
    const wrapped = await client.get<{ metadata?: Record<string, unknown> }>(stockMetadataPath(id));
    metadata = wrapped.metadata ?? wrapped;
  } catch {
    /* keep list payload */
  }
  const current = readEnvelope({ ...stock, metadata });
  const next = {
    ...emptyEnvelope(),
    ...current.value,
    condition: input.condition,
    testStatus: input.testStatus,
    defectNotes: input.defectNotes,
    mfrSerial: input.mfrSerial,
  };
  const audit = [
    `Inspect ${input.sku} by ${input.actor}`,
    `condition=${input.condition ?? ""}`,
    `test=${input.testStatus}`,
    `mfrSerial=${input.mfrSerial ?? ""}`,
  ].join(" | ");
  const patch: Record<string, unknown> = { notes: audit };
  if (input.location !== undefined) {
    patch.location = await findOrCreateLocation(client, input.location);
  }
  await client.patch(`/api/stock/${id}/`, patch);
  await client.patch(stockMetadataPath(id), { metadata: { [META_KEY]: next } });
  try {
    await client.post("/api/stock/test/", {
      stock_item: id,
      test: "Floor inspect",
      result: input.testStatus === "failed" ? false : true,
      value: input.condition ?? "",
      notes: input.defectNotes ?? "",
    });
  } catch {
    // History still exists on the stock notes + metadata current state.
  }
  const unit = await loadUnitBySku(client, input.sku);
  if (!unit) throw new Error("Inspect saved but unit could not be reloaded");
  return unit;
}
