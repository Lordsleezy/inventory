import { hasPhotos, type ListingState } from "@floor/domain";
import { InventreeClient } from "./client.ts";
import { recordId } from "./list.ts";
import { emptyEnvelope, META_KEY } from "./metadata.ts";
import { stockMetadataPath } from "./paths.ts";
import { floorLog } from "./log.ts";
import { readEnvelope, type InventreeStock } from "./map-unit.ts";
import { loadUnitBySku } from "./units.ts";

export async function setListing(
  client: InventreeClient,
  input: {
    sku: string;
    channel: string;
    state: ListingState;
    url: string | null;
    actor: string;
  },
) {
  const unit = await loadUnitBySku(client, input.sku);
  if (!unit) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  if (input.state === "LISTED" && !hasPhotos(unit)) {
    throw Object.assign(new Error("Photos required before listing"), { status: 409 });
  }
  const stocks = await client.listAll<InventreeStock>(
    `/api/stock/?serial=${encodeURIComponent(input.sku)}`,
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
  const listings = current.value.listings.map((row) =>
    row.channel === input.channel
      ? {
          ...row,
          state: input.state,
          url: input.url,
          listedOn: input.state === "LISTED" ? new Date().toISOString().slice(0, 10) : row.listedOn,
        }
      : row,
  );
  if (!listings.some((row) => row.channel === input.channel)) {
    listings.push({
      channel: input.channel,
      state: input.state,
      url: input.url,
      listedOn: input.state === "LISTED" ? new Date().toISOString().slice(0, 10) : null,
    });
  }
  const next = { ...emptyEnvelope(), ...current.value, listings };
  await client.patch(`/api/stock/${id}/`, {
    notes: `Listing ${input.sku} ${input.channel}=${input.state} by ${input.actor}`,
  });
  await client.patch(stockMetadataPath(id), { metadata: { [META_KEY]: next } });
  floorLog("listing_set", {
    sku: input.sku,
    channel: input.channel,
    state: input.state,
    actor: input.actor,
  });
  const after = await loadUnitBySku(client, input.sku);
  if (!after) throw new Error("Listing saved but unit could not be reloaded");
  return after;
}
