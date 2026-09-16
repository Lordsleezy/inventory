import { parsePhotoFilename, stockPhotoFilename } from "@floor/domain";
import { InventreeClient } from "./client.ts";
import { recordId } from "./list.ts";
import { emptyEnvelope, META_KEY, type LrosEnvelope } from "./metadata.ts";
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

export function sortPhotos(
  photos: StockAttachment[],
  order: number[] | undefined,
  primaryId: number | null,
) {
  const index = new Map((order ?? []).map((id, i) => [id, i]));
  return [...photos].sort((a, b) => {
    const ia = index.has(a.pk) ? (index.get(a.pk) as number) : 10_000 + a.pk;
    const ib = index.has(b.pk) ? (index.get(b.pk) as number) : 10_000 + b.pk;
    if (ia !== ib) return ia - ib;
    if (primaryId === a.pk) return -1;
    if (primaryId === b.pk) return 1;
    return a.pk - b.pk;
  });
}

async function loadStock(client: InventreeClient, sku: string) {
  const stocks = await client.listAll<InventreeStock>(`/api/stock/?serial=${encodeURIComponent(sku)}`);
  const stock = stocks.find((row) => row.serial === sku);
  if (!stock) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  const id = recordId(stock);
  let metadata: Record<string, unknown> | null = (stock.metadata as Record<string, unknown> | undefined) ?? null;
  try {
    const wrapped = await client.get<{ metadata?: Record<string, unknown> }>(stockMetadataPath(id));
    metadata = wrapped.metadata ?? wrapped;
  } catch {
    /* keep list payload */
  }
  return { ...stock, metadata };
}

async function patchEnvelope(
  client: InventreeClient,
  sku: string,
  mutate: (env: LrosEnvelope) => void,
) {
  const stock = await loadStock(client, sku);
  const current = readEnvelope(stock);
  const next = { ...emptyEnvelope(), ...current.value };
  mutate(next);
  await client.patch(stockMetadataPath(recordId(stock)), { metadata: { [META_KEY]: next } });
}

export async function listUnitPhotos(client: InventreeClient, sku: string) {
  const unit = await loadUnitBySku(client, sku);
  if (!unit?.stockId) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  const stock = await loadStock(client, sku);
  const photos = sortPhotos(
    await listStockAttachments(client, unit.stockId),
    readEnvelope(stock).value.photoOrder,
    unit.primaryAttachmentId,
  );
  return { unit, photos };
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
  const copy = Uint8Array.from(input.bytes);
  form.set("attachment", new File([copy], input.filename));
  const created = await client.postForm<StockAttachment>("/api/attachment/", form);
  const createdId = recordId(created);
  await patchEnvelope(client, input.sku, (env) => {
    if (env.primaryAttachmentId == null) env.primaryAttachmentId = createdId;
    const order = [...(env.photoOrder ?? [])];
    if (!order.includes(createdId)) order.push(createdId);
    env.photoOrder = order;
  });
  floorLog("photo_attach", {
    sku: input.sku,
    file: input.filename,
    attachmentId: createdId,
    actor: input.actor,
  });
  return loadUnitBySku(client, input.sku);
}

export async function uploadStockPhoto(
  client: InventreeClient,
  input: { sku: string; originalName: string; bytes: Uint8Array; actor: string },
) {
  const filename = stockPhotoFilename(input.sku, input.originalName);
  if (!filename) {
    throw Object.assign(new Error("Use a JPEG, PNG, WebP, GIF, or HEIC photo"), { status: 400 });
  }
  return attachStockPhoto(client, {
    sku: input.sku,
    filename,
    bytes: input.bytes,
    actor: input.actor,
  });
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
  await patchEnvelope(client, input.sku, (env) => {
    env.primaryAttachmentId = input.attachmentId;
  });
  return loadUnitBySku(client, input.sku);
}

export async function reorderStockPhotos(
  client: InventreeClient,
  input: { sku: string; order: number[] },
) {
  const unit = await loadUnitBySku(client, input.sku);
  if (!unit?.stockId) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  const atts = await listStockAttachments(client, unit.stockId);
  const known = new Set(atts.map((row) => row.pk));
  if (input.order.some((id) => !known.has(id))) {
    throw Object.assign(new Error("Photo list does not match this item"), { status: 400 });
  }
  const rest = atts.map((row) => row.pk).filter((id) => !input.order.includes(id));
  await patchEnvelope(client, input.sku, (env) => {
    env.photoOrder = [...input.order, ...rest];
  });
  return listUnitPhotos(client, input.sku);
}

export async function deleteStockPhoto(
  client: InventreeClient,
  input: { sku: string; attachmentId: number; actor: string },
) {
  const unit = await loadUnitBySku(client, input.sku);
  if (!unit?.stockId) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  const atts = await listStockAttachments(client, unit.stockId);
  if (!atts.some((row) => row.pk === input.attachmentId)) {
    throw Object.assign(new Error("That photo is not on this item"), { status: 404 });
  }
  await client.delete(`/api/attachment/${input.attachmentId}/`);
  const remaining = atts.filter((row) => row.pk !== input.attachmentId).map((row) => row.pk);
  await patchEnvelope(client, input.sku, (env) => {
    env.photoOrder = (env.photoOrder ?? remaining).filter((id) => id !== input.attachmentId);
    if (env.primaryAttachmentId === input.attachmentId) {
      env.primaryAttachmentId = remaining[0] ?? null;
    }
  });
  floorLog("photo_delete", { sku: input.sku, attachmentId: input.attachmentId, actor: input.actor });
  return listUnitPhotos(client, input.sku);
}

export async function readStockPhoto(
  client: InventreeClient,
  input: { sku: string; attachmentId: number },
) {
  const unit = await loadUnitBySku(client, input.sku);
  if (!unit?.stockId) throw Object.assign(new Error("No item with that SKU"), { status: 404 });
  const att = (await listStockAttachments(client, unit.stockId)).find((row) => row.pk === input.attachmentId);
  if (!att) throw Object.assign(new Error("That photo is not on this item"), { status: 404 });
  const path = att.attachment.startsWith("http")
    ? att.attachment
    : att.attachment.startsWith("/")
      ? att.attachment
      : `/${att.attachment}`;
  const file = await client.getRaw(path);
  return { ...file, filename: att.filename };
}
