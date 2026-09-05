import { parsePhotoFilename } from "@floor/domain";
import { InventreeClient } from "./client.ts";
import { recordId } from "./list.ts";
import { emptyEnvelope, META_KEY } from "./metadata.ts";
import { stockMetadataPath } from "./paths.ts";
import { floorLog } from "./log.ts";
import { readEnvelope, type InventreeStock } from "./map-unit.ts";
import { loadUnitBySku } from "./units.ts";

export type StockAttachment = {
  pk: number;
  filename: string;
  attachment: string;
  comment: string | null;
  model_id: number;
};

export async function listStockAttachments(client: InventreeClient, stockId: number) {
  return client.listAll<StockAttachment>(
    `/api/attachment/?model_type=stockitem&model_id=${stockId}`,
  );
}

export async function attachStockPhoto(
  client: InventreeClient,
  input: { sku: string; filename: string; bytes: Uint8Array; actor: string },
) {
  const parsed = parsePhotoFilename(input.filename);
  if (!parsed || parsed.sku !== input.sku) {
    throw Object.assign(new Error("Filename does not match that SKU"), { status: 400 });
  }
  const unit = await loadUnitBySku(client, input.sku);
  if (!unit?.stockId) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  const form = new FormData();
  form.set("model_type", "stockitem");
  form.set("model_id", String(unit.stockId));
  form.set("comment", `Floor photo ${input.filename} (${input.actor})`);
  form.set("attachment", new Blob([input.bytes]), input.filename);
  const created = await client.postForm<StockAttachment>("/api/attachment/", form);
  const stocks = await client.listAll<InventreeStock>(
    `/api/stock/?serial=${encodeURIComponent(input.sku)}`,
  );
  const stock = stocks.find((row) => row.serial === input.sku);
  if (stock && unit.primaryAttachmentId == null) {
    const current = readEnvelope(stock);
    const next = {
      ...emptyEnvelope(),
      ...current.value,
      primaryAttachmentId: recordId(created),
    };
    await client.patch(stockMetadataPath(recordId(stock)), { metadata: { [META_KEY]: next } });
  }
  floorLog("photo_attach", {
    sku: input.sku,
    file: input.filename,
    attachmentId: recordId(created),
    actor: input.actor,
  });
  return loadUnitBySku(client, input.sku);
}

export async function setPrimaryPhoto(
  client: InventreeClient,
  input: { sku: string; attachmentId: number },
) {
  const unit = await loadUnitBySku(client, input.sku);
  if (!unit?.stockId) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  const atts = await listStockAttachments(client, unit.stockId);
  if (!atts.some((row) => row.pk === input.attachmentId)) {
    throw Object.assign(new Error("That photo is not on this item"), { status: 404 });
  }
  const stocks = await client.listAll<InventreeStock>(
    `/api/stock/?serial=${encodeURIComponent(input.sku)}`,
  );
  const stock = stocks.find((row) => row.serial === input.sku);
  if (!stock) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  const current = readEnvelope(stock);
  const next = {
    ...emptyEnvelope(),
    ...current.value,
    primaryAttachmentId: input.attachmentId,
  };
  await client.patch(stockMetadataPath(recordId(stock)), { metadata: { [META_KEY]: next } });
  return loadUnitBySku(client, input.sku);
}
