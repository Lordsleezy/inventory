import {
  belowFloorError,
  cannotSellReason,
  centsToMoneyString,
  isRestockState,
  isSku,
  moneyStringToCents,
  saleTotals,
  withSaleTotals,
  saleHistoryFromReceipt,
  snapshotReceiptLine,
  type Cents,
  type FloorSale,
  type RestockState,
  type SaleCustomer,
  type SaleHistoryRow,
  type SaleLine,
  type SalePayment,
  type SaleReceipt,
  type SaleReceiptFileRecord,
  type SaleStatus,
  parseReceiptFileRecord,
  publicReceiptFile,
} from "@floor/domain";
import { InventreeClient, InventreeError } from "./client.ts";
import { recordId } from "./list.ts";
import { floorLog } from "./log.ts";
import { emptyEnvelope, META_KEY } from "./metadata.ts";
import { salesOrderMetadataPath, stockMetadataPath } from "./paths.ts";
import { statusCodeOf, statusForFloorState } from "./status.ts";
import { readEnvelope, type InventreeStock } from "./map-unit.ts";
import { loadUnitBySku } from "./units.ts";

const WALK_IN = "Walk-in";
const OPEN_SO_STATUS = new Set([10, 15]);
const COMPLETED_SO_STATUS = 20;
const CANCELLED_SO_STATUS = 40;

type SoRecord = {
  pk?: number;
  id?: number;
  reference?: string;
  status?: unknown;
  status_text?: string;
  customer?: number;
  description?: string;
};

type SoLineRecord = {
  pk?: number;
  id?: number;
  order?: number;
  part?: number;
  quantity?: number | string;
  sale_price?: number | string | null;
};

type SoAllocRecord = {
  pk?: number;
  id?: number;
  item?: number;
  line?: number;
  order?: number;
  shipment?: number | null;
  quantity?: number | string;
};

type CompanyRecord = {
  pk?: number;
  id?: number;
  name?: string;
  phone?: string;
  email?: string;
  is_customer?: boolean;
};

type ShipmentRecord = {
  pk?: number;
  id?: number;
  shipment_date?: string | null;
};

type SoMeta = {
  payments: SalePayment[];
  customer: SaleCustomer;
  saleDiscountCents: Cents;
  taxRateBps: number;
  parked: boolean;
  parkedAt: string | null;
  actor: string | null;
  receipt: SaleReceipt | null;
  receiptFile: SaleReceiptFileRecord | null;
};

function fail(message: string, status: number): never {
  throw Object.assign(new Error(message), { status });
}

function dollarsToCents(value: unknown): Cents {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) fail("Unreadable line price", 500);
  return moneyStringToCents(n.toFixed(2)) ?? 0;
}

function emptyCustomer(): SaleCustomer {
  return { name: null, phone: null, email: null };
}

function emptyMeta(taxRateBps: number): SoMeta {
  return {
    payments: [],
    customer: emptyCustomer(),
    saleDiscountCents: 0,
    taxRateBps,
    parked: false,
    parkedAt: null,
    actor: null,
    receipt: null,
    receiptFile: null,
  };
}

function parseMeta(raw: unknown, taxRateBps: number): SoMeta {
  const base = emptyMeta(taxRateBps);
  if (!raw || typeof raw !== "object") return base;
  const row = raw as Record<string, unknown>;
  const customer = row.customer && typeof row.customer === "object" ? (row.customer as SaleCustomer) : emptyCustomer();
  const payments = Array.isArray(row.payments) ? (row.payments as SalePayment[]) : [];
  return {
    payments,
    customer: {
      name: customer.name ?? null,
      phone: customer.phone ?? null,
      email: customer.email ?? null,
    },
    saleDiscountCents: typeof row.saleDiscountCents === "number" ? row.saleDiscountCents : 0,
    taxRateBps: typeof row.taxRateBps === "number" ? row.taxRateBps : taxRateBps,
    parked: Boolean(row.parked),
    parkedAt: typeof row.parkedAt === "string" ? row.parkedAt : null,
    actor: typeof row.actor === "string" ? row.actor : null,
    receipt: row.receipt && typeof row.receipt === "object" ? (row.receipt as SaleReceipt) : null,
    receiptFile: parseReceiptFileRecord(row.receiptFile),
  };
}

function soStatus(status: unknown, parked: boolean): SaleStatus {
  const code = statusCodeOf(status);
  if (code === COMPLETED_SO_STATUS) return "completed";
  if (code === CANCELLED_SO_STATUS) return "cancelled";
  if (parked) return "parked";
  if (code === null || OPEN_SO_STATUS.has(code)) return "open";
  return "open";
}

async function readSoMeta(client: InventreeClient, soId: number, taxRateBps: number): Promise<SoMeta> {
  try {
    const wrapped = await client.get<{ metadata?: { lros?: unknown } }>(salesOrderMetadataPath(soId));
    return parseMeta(wrapped.metadata?.lros ?? (wrapped as { lros?: unknown }).lros, taxRateBps);
  } catch {
    return emptyMeta(taxRateBps);
  }
}

async function writeSoMeta(client: InventreeClient, soId: number, meta: SoMeta) {
  await client.patch(salesOrderMetadataPath(soId), { metadata: { [META_KEY]: meta } });
}

async function loadStockBySku(client: InventreeClient, sku: string): Promise<InventreeStock> {
  const stocks = await client.listAll<InventreeStock>(
    `/api/stock/?serial=${encodeURIComponent(sku)}&part_detail=true`,
  );
  const stock = stocks.find((row) => row.serial === sku);
  if (!stock) fail("No item with that SKU", 404);
  return stock;
}

async function findOrCreateLocation(client: InventreeClient, name: string): Promise<number> {
  const rows = await client.listAll<{ pk?: number; id?: number; name?: string }>(
    `/api/stock/location/?search=${encodeURIComponent(name)}`,
  );
  const exact = rows.find((row) => row.name === name);
  if (exact) return recordId(exact);
  const made = await client.post<{ pk?: number; id?: number }>("/api/stock/location/", { name });
  return recordId(made);
}

function conflictIfLocked(err: unknown): never {
  if (err instanceof InventreeError && err.status === 400) {
    const text = JSON.stringify(err.body);
    if (/unavailable/i.test(text) || /exceeded/i.test(text) || /allocated/i.test(text)) {
      fail("That SKU is already in a sale", 409);
    }
  }
  throw err;
}

export async function ensureWalkInCustomer(client: InventreeClient): Promise<number> {
  const rows = await client.listAll<CompanyRecord>("/api/company/?is_customer=true");
  const existing = rows.find((row) => row.name === WALK_IN);
  if (existing) return recordId(existing);
  const created = await client.post<CompanyRecord>("/api/company/", {
    name: WALK_IN,
    is_customer: true,
    is_supplier: false,
  });
  return recordId(created);
}

export async function ensureCustomer(client: InventreeClient, customer: SaleCustomer): Promise<number> {
  const name = customer.name?.trim() || "";
  const phone = customer.phone?.trim() || "";
  const email = customer.email?.trim() || "";
  if (!name && !phone && !email) return ensureWalkInCustomer(client);
  const label = name || phone || email;
  const rows = await client.listAll<CompanyRecord>(`/api/company/?search=${encodeURIComponent(label)}`);
  const existing = rows.find((row) => row.name === label);
  if (existing) {
    await client.patch(`/api/company/${recordId(existing)}/`, {
      phone,
      email,
      is_customer: true,
    });
    return recordId(existing);
  }
  const created = await client.post<CompanyRecord>("/api/company/", {
    name: label,
    is_customer: true,
    is_supplier: false,
    phone,
    email,
  });
  return recordId(created);
}

async function linesFor(client: InventreeClient, soId: number) {
  return client.listAll<SoLineRecord>(`/api/order/so-line/?order=${soId}`);
}

async function allocsFor(client: InventreeClient, soId: number) {
  return client.listAll<SoAllocRecord>(`/api/order/so-allocation/?order=${soId}`);
}

async function buildLines(client: InventreeClient, soId: number): Promise<SaleLine[]> {
  const lines = await linesFor(client, soId);
  const allocs = await allocsFor(client, soId);
  const out: SaleLine[] = [];
  for (const line of lines) {
    const alloc = allocs.find((row) => row.line === recordId(line));
    if (!alloc?.item) continue;
    const stock = await client.get<InventreeStock>(`/api/stock/${alloc.item}/`);
    const sku = stock.serial && isSku(stock.serial) ? stock.serial : "";
    const unit = sku ? await loadUnitBySku(client, sku) : null;
    out.push({
      sku: sku || stock.serial || `pk-${alloc.item}`,
      stockId: alloc.item,
      lineId: recordId(line),
      title: unit ? [unit.brand, unit.model].filter(Boolean).join(" ") || unit.title : "",
      brand: unit?.brand ?? "",
      model: unit?.model ?? "",
      description: unit?.title ?? "",
      condition: unit?.condition ?? null,
      askCents: unit?.askCents ?? null,
      floorCents: unit?.floorCents ?? null,
      priceCents: dollarsToCents(line.sale_price),
    });
  }
  return out;
}

export async function loadSale(
  client: InventreeClient,
  soId: number,
  taxRateBps: number,
): Promise<FloorSale> {
  const so = await client.get<SoRecord>(`/api/order/so/${soId}/`);
  const meta = await readSoMeta(client, soId, taxRateBps);
  const lines = await buildLines(client, soId);
  return withSaleTotals({
    id: recordId(so),
    reference: so.reference ?? `SO-${soId}`,
    status: soStatus(so.status, meta.parked),
    customer: meta.customer,
    lines,
    saleDiscountCents: meta.saleDiscountCents,
    taxRateBps: meta.taxRateBps,
    payments: meta.payments,
    parkedAt: meta.parkedAt,
    receipt: meta.receipt,
    receiptFile: publicReceiptFile(meta.receiptFile),
  });
}

export async function listOpenSales(client: InventreeClient, taxRateBps: number): Promise<FloorSale[]> {
  const rows = await client.listAll<SoRecord>("/api/order/so/");
  const open = rows.filter((row) => {
    const code = statusCodeOf(row.status);
    return code !== null && OPEN_SO_STATUS.has(code);
  });
  const sales: FloorSale[] = [];
  for (const row of open) {
    sales.push(await loadSale(client, recordId(row), taxRateBps));
  }
  return sales;
}

export async function createSale(
  client: InventreeClient,
  input: { customer: SaleCustomer; taxRateBps: number; actor: string },
): Promise<FloorSale> {
  const customerId = await ensureCustomer(client, input.customer);
  const so = await client.post<SoRecord>("/api/order/so/", {
    customer: customerId,
    description: "floor sale",
  });
  const meta = emptyMeta(input.taxRateBps);
  meta.customer = input.customer;
  meta.actor = input.actor;
  await writeSoMeta(client, recordId(so), meta);
  floorLog("sale_create", { so: recordId(so), actor: input.actor });
  return loadSale(client, recordId(so), input.taxRateBps);
}

function assertOpen(sale: FloorSale) {
  if (sale.status !== "open" && sale.status !== "parked") {
    fail("That sale is no longer open", 409);
  }
}

function assertFloor(priceCents: Cents, floorCents: Cents | null, role: "admin" | "staff", confirmed: boolean) {
  const blocked = belowFloorError(priceCents, floorCents, role, confirmed);
  if (blocked) fail(blocked.message, blocked.status);
}

export async function addSaleItem(
  client: InventreeClient,
  input: {
    soId: number;
    sku: string;
    priceCents: Cents | null;
    taxRateBps: number;
    role: "admin" | "staff";
    confirmBelowFloor: boolean;
    actor: string;
  },
): Promise<FloorSale> {
  if (!isSku(input.sku)) fail("SKU must be five digits", 400);
  const sale = await loadSale(client, input.soId, input.taxRateBps);
  assertOpen(sale);
  if (sale.lines.some((line) => line.sku === input.sku)) fail("That SKU is already on this sale", 409);
  const unit = await loadUnitBySku(client, input.sku);
  if (!unit) fail("No item with that SKU", 404);
  const reason = cannotSellReason(unit);
  if (reason) fail(reason, 409);
  const priceCents = input.priceCents ?? unit.askCents;
  if (priceCents === null) fail("Enter a price", 400);
  assertFloor(priceCents, unit.floorCents, input.role, input.confirmBelowFloor);
  const stock = await loadStockBySku(client, input.sku);
  const partId = stock.part ?? stock.part_detail?.pk;
  if (!partId) fail("Item is missing a part record", 500);
  const line = await client.post<SoLineRecord>("/api/order/so-line/", {
    order: input.soId,
    part: partId,
    quantity: 1,
    sale_price: centsToMoneyString(priceCents),
  });
  try {
    await client.post(`/api/order/so/${input.soId}/allocate-serials/`, {
      line_item: recordId(line),
      quantity: 1,
      serial_numbers: input.sku,
    });
  } catch (err) {
    try {
      await client.delete(`/api/order/so-line/${recordId(line)}/`);
    } catch {
      /* line leftover is still better than a double-sold unit */
    }
    conflictIfLocked(err);
  }
  floorLog("sale_add", { so: input.soId, sku: input.sku, actor: input.actor });
  return loadSale(client, input.soId, input.taxRateBps);
}

export async function removeSaleItem(
  client: InventreeClient,
  input: { soId: number; sku: string; taxRateBps: number; actor: string },
): Promise<FloorSale> {
  const sale = await loadSale(client, input.soId, input.taxRateBps);
  assertOpen(sale);
  const line = sale.lines.find((row) => row.sku === input.sku);
  if (!line) fail("That SKU is not on this sale", 404);
  const allocs = await allocsFor(client, input.soId);
  const alloc = allocs.find((row) => row.line === line.lineId);
  if (alloc) await client.delete(`/api/order/so-allocation/${recordId(alloc)}/`);
  await client.delete(`/api/order/so-line/${line.lineId}/`);
  floorLog("sale_remove", { so: input.soId, sku: input.sku, actor: input.actor });
  return loadSale(client, input.soId, input.taxRateBps);
}

export async function setSaleLinePrice(
  client: InventreeClient,
  input: {
    soId: number;
    sku: string;
    priceCents: Cents;
    taxRateBps: number;
    role: "admin" | "staff";
    confirmBelowFloor: boolean;
  },
): Promise<FloorSale> {
  const sale = await loadSale(client, input.soId, input.taxRateBps);
  assertOpen(sale);
  const line = sale.lines.find((row) => row.sku === input.sku);
  if (!line) fail("That SKU is not on this sale", 404);
  assertFloor(input.priceCents, line.floorCents, input.role, input.confirmBelowFloor);
  await client.patch(`/api/order/so-line/${line.lineId}/`, {
    sale_price: centsToMoneyString(input.priceCents),
  });
  return loadSale(client, input.soId, input.taxRateBps);
}

export async function setSaleDiscount(
  client: InventreeClient,
  input: { soId: number; saleDiscountCents: Cents; taxRateBps: number },
): Promise<FloorSale> {
  const sale = await loadSale(client, input.soId, input.taxRateBps);
  assertOpen(sale);
  const meta = await readSoMeta(client, input.soId, input.taxRateBps);
  meta.saleDiscountCents = Math.max(0, input.saleDiscountCents);
  await writeSoMeta(client, input.soId, meta);
  return loadSale(client, input.soId, input.taxRateBps);
}

export async function setSaleCustomer(
  client: InventreeClient,
  input: { soId: number; customer: SaleCustomer; taxRateBps: number },
): Promise<FloorSale> {
  const sale = await loadSale(client, input.soId, input.taxRateBps);
  assertOpen(sale);
  const customerId = await ensureCustomer(client, input.customer);
  await client.patch(`/api/order/so/${input.soId}/`, { customer: customerId });
  const meta = await readSoMeta(client, input.soId, input.taxRateBps);
  meta.customer = input.customer;
  await writeSoMeta(client, input.soId, meta);
  return loadSale(client, input.soId, input.taxRateBps);
}

export async function parkSale(
  client: InventreeClient,
  input: { soId: number; taxRateBps: number; actor: string },
): Promise<FloorSale> {
  const sale = await loadSale(client, input.soId, input.taxRateBps);
  assertOpen(sale);
  if (sale.lines.length === 0) fail("Nothing to park", 400);
  const meta = await readSoMeta(client, input.soId, input.taxRateBps);
  meta.parked = true;
  meta.parkedAt = new Date().toISOString();
  await writeSoMeta(client, input.soId, meta);
  floorLog("sale_park", { so: input.soId, actor: input.actor });
  return loadSale(client, input.soId, input.taxRateBps);
}

export async function cancelSale(
  client: InventreeClient,
  input: { soId: number; taxRateBps: number; actor: string },
): Promise<FloorSale> {
  const sale = await loadSale(client, input.soId, input.taxRateBps);
  assertOpen(sale);
  const allocs = await allocsFor(client, input.soId);
  for (const alloc of allocs) {
    await client.delete(`/api/order/so-allocation/${recordId(alloc)}/`);
  }
  const lines = await linesFor(client, input.soId);
  for (const line of lines) {
    await client.delete(`/api/order/so-line/${recordId(line)}/`);
  }
  try {
    await client.post(`/api/order/so/${input.soId}/cancel/`, {});
  } catch (err) {
    if (!(err instanceof InventreeError && err.status === 400)) throw err;
  }
  floorLog("sale_cancel", { so: input.soId, actor: input.actor });
  return loadSale(client, input.soId, input.taxRateBps);
}

async function waitForShipment(client: InventreeClient, shipmentId: number) {
  const started = Date.now();
  while (Date.now() - started < 25000) {
    const ship = await client.get<ShipmentRecord>(`/api/order/so/shipment/${shipmentId}/`);
    if (ship.shipment_date) return ship;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  fail("Shipment did not finish. Is the InvenTree worker running?", 504);
}

export async function completeSale(
  client: InventreeClient,
  input: {
    soId: number;
    taxRateBps: number;
    paymentMethod: string;
    role: "admin" | "staff";
    confirmBelowFloor: boolean;
    actor: string;
    channel?: string;
  },
): Promise<FloorSale> {
  const sale = await loadSale(client, input.soId, input.taxRateBps);
  assertOpen(sale);
  if (sale.lines.length === 0) fail("Nothing to complete", 400);
  if (!input.paymentMethod.trim()) fail("Choose a payment method", 400);
  const channel = (input.channel ?? "floor").trim() || "floor";
  for (const line of sale.lines) {
    assertFloor(line.priceCents, line.floorCents, input.role, input.confirmBelowFloor);
  }
  const totals = saleTotals({
    linePriceCents: sale.lines.map((line) => line.priceCents),
    saleDiscountCents: sale.saleDiscountCents,
    taxRateBps: sale.taxRateBps,
  });
  try {
    await client.post(`/api/order/so/${input.soId}/issue/`, {});
  } catch (err) {
    if (!(err instanceof InventreeError && (err.status === 400 || err.status === 409))) throw err;
  }
  const shipment = await client.post<ShipmentRecord>("/api/order/so/shipment/", { order: input.soId });
  const shipmentId = recordId(shipment);
  const allocs = await allocsFor(client, input.soId);
  for (const alloc of allocs) {
    if (!alloc.shipment) {
      await client.patch(`/api/order/so-allocation/${recordId(alloc)}/`, { shipment: shipmentId });
    }
  }
  await client.post(`/api/order/so/shipment/${shipmentId}/ship/`, {});
  await waitForShipment(client, shipmentId);
  await client.post(`/api/order/so/${input.soId}/complete/`, {});
  const soldOn = new Date().toISOString();
  const meta = await readSoMeta(client, input.soId, input.taxRateBps);
  meta.parked = false;
  meta.payments = [
    ...meta.payments,
    { method: input.paymentMethod, cents: totals.totalCents, at: soldOn },
  ];
  meta.receipt = {
    saleId: input.soId,
    reference: sale.reference,
    soldOn,
    channel,
    customer: meta.customer,
    lines: sale.lines.map((line) => snapshotReceiptLine(line, channel)),
    saleDiscountCents: sale.saleDiscountCents,
    taxRateBps: sale.taxRateBps,
    subtotalCents: totals.subtotalCents,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    payments: meta.payments,
  };
  await writeSoMeta(client, input.soId, meta);
  for (const line of sale.lines) {
    const stock = await loadStockBySku(client, line.sku);
    const current = readEnvelope(stock);
    const next = {
      ...emptyEnvelope(),
      ...current.value,
      sale: {
        priceCents: line.priceCents,
        channel,
        soldOn,
        salesOrderId: String(input.soId),
      },
    };
    await client.patch(`/api/stock/${recordId(stock)}/`, {
      notes: `Sold ${line.sku} on ${sale.reference} by ${input.actor}`,
    });
    await client.patch(stockMetadataPath(recordId(stock)), { metadata: { [META_KEY]: next } });
  }
  floorLog("sale_complete", {
    so: input.soId,
    actor: input.actor,
    totalCents: totals.totalCents,
    method: input.paymentMethod,
    channel,
  });
  return loadSale(client, input.soId, input.taxRateBps);
}

export async function quickSell(
  client: InventreeClient,
  input: {
    sku: string;
    channel: string;
    proceedsCents: Cents;
    role: "admin" | "staff";
    confirmBelowFloor: boolean;
    actor: string;
  },
): Promise<{ sale: FloorSale; unit: NonNullable<Awaited<ReturnType<typeof loadUnitBySku>>> }> {
  const channel = input.channel.trim();
  if (!channel) fail("Pick a channel", 400);
  if (!Number.isInteger(input.proceedsCents) || input.proceedsCents < 0) {
    fail("Enter what you actually got", 400);
  }
  const unit = await loadUnitBySku(client, input.sku);
  if (!unit) fail("No item with that SKU", 404);
  const reason = cannotSellReason(unit);
  if (reason) fail(reason, 409);
  assertFloor(input.proceedsCents, unit.floorCents, input.role, input.confirmBelowFloor);
  const sale = await createSale(client, {
    customer: { name: null, phone: null, email: null },
    taxRateBps: 0,
    actor: input.actor,
  });
  try {
    await addSaleItem(client, {
      soId: sale.id,
      sku: input.sku,
      priceCents: input.proceedsCents,
      taxRateBps: 0,
      role: input.role,
      confirmBelowFloor: input.confirmBelowFloor,
      actor: input.actor,
    });
    const completed = await completeSale(client, {
      soId: sale.id,
      taxRateBps: 0,
      paymentMethod: channel,
      channel,
      role: input.role,
      confirmBelowFloor: input.confirmBelowFloor,
      actor: input.actor,
    });
    const sold = await loadUnitBySku(client, input.sku);
    if (!sold) fail("Sale completed but the item could not be reloaded", 500);
    return { sale: completed, unit: sold };
  } catch (err) {
    try {
      await cancelSale(client, { soId: sale.id, taxRateBps: 0, actor: input.actor });
    } catch {
      /* lock from allocate-serials must not be left as an open sale if we can help it */
    }
    throw err;
  }
}

export async function findSaleForSku(
  client: InventreeClient,
  sku: string,
  taxRateBps: number,
): Promise<FloorSale> {
  if (!isSku(sku)) fail("SKU must be five digits", 400);
  const unit = await loadUnitBySku(client, sku);
  if (!unit) fail("No item with that SKU", 404);
  if (unit.sale?.salesOrderId) {
    const id = Number(unit.sale.salesOrderId);
    if (Number.isInteger(id)) return loadSale(client, id, taxRateBps);
  }
  const stock = await loadStockBySku(client, sku);
  if (stock.sales_order) return loadSale(client, stock.sales_order, taxRateBps);
  const open = await listOpenSales(client, taxRateBps);
  const match = open.find((sale) => sale.lines.some((line) => line.sku === sku));
  if (match) return match;
  fail("No sale found for that SKU", 404);
}

export async function returnSaleItem(
  client: InventreeClient,
  input: {
    soId: number;
    sku: string;
    restock: string;
    reason: string;
    taxRateBps: number;
    actor: string;
  },
) {
  const reason = input.reason.trim();
  if (!reason) fail("Return requires a reason", 400);
  if (!isRestockState(input.restock)) fail("Restock must be available, repair, or scrapped", 400);
  const restock = input.restock as RestockState;
  if (!isSku(input.sku)) fail("SKU must be five digits", 400);
  const sale = await loadSale(client, input.soId, input.taxRateBps);
  if (sale.status !== "completed") fail("Only completed sales can be returned", 409);
  const line = sale.lines.find((row) => row.sku === input.sku);
  if (!line) fail("That SKU is not on this sale", 404);
  const unit = await loadUnitBySku(client, input.sku);
  if (!unit) fail("No item with that SKU", 404);
  if (unit.state !== "sold") fail("That item is not sold", 409);
  const stock = await loadStockBySku(client, input.sku);
  const locationId = stock.location
    ? Number(stock.location)
    : await findOrCreateLocation(client, "Floor");
  await client.post("/api/stock/return/", {
    items: [
      {
        pk: recordId(stock),
        quantity: 1,
        status: statusForFloorState(restock),
        merge: false,
      },
    ],
    location: locationId,
    merge: false,
    notes: `Return ${input.sku} from ${sale.reference}: ${reason} (${input.actor})`,
  });
  const current = readEnvelope(await loadStockBySku(client, input.sku));
  const next = {
    ...emptyEnvelope(),
    ...current.value,
    sale: null,
  };
  await client.patch(stockMetadataPath(recordId(stock)), { metadata: { [META_KEY]: next } });
  floorLog("sale_return", {
    so: input.soId,
    sku: input.sku,
    restock,
    actor: input.actor,
  });
  const after = await loadUnitBySku(client, input.sku);
  if (!after) fail("Returned but unit could not be reloaded", 500);
  return { unit: after, sale: await loadSale(client, input.soId, input.taxRateBps) };
}

export async function listCompletedSales(
  client: InventreeClient,
  taxRateBps: number,
): Promise<SaleHistoryRow[]> {
  const rows = await client.listAll<SoRecord>("/api/order/so/");
  const completed = rows.filter((row) => statusCodeOf(row.status) === COMPLETED_SO_STATUS);
  const out: SaleHistoryRow[] = [];
  for (const row of completed) {
    const sale = await loadSale(client, recordId(row), taxRateBps);
    if (sale.receipt) {
      out.push(saleHistoryFromReceipt(sale.receipt, sale.receiptFile));
      continue;
    }
    out.push(
      saleHistoryFromReceipt(
        {
          saleId: sale.id,
          reference: sale.reference,
          soldOn: sale.payments[0]?.at ?? "",
          channel: "floor",
          customer: sale.customer,
          lines: sale.lines.map((line) => snapshotReceiptLine(line, "floor")),
          saleDiscountCents: sale.saleDiscountCents,
          taxRateBps: sale.taxRateBps,
          subtotalCents: sale.subtotalCents,
          taxCents: sale.taxCents,
          totalCents: sale.totalCents,
          payments: sale.payments,
        },
        sale.receiptFile,
      ),
    );
  }
  out.sort((a, b) => (a.soldOn < b.soldOn ? 1 : a.soldOn > b.soldOn ? -1 : 0));
  return out;
}

export async function loadSaleReceiptFile(
  client: InventreeClient,
  soId: number,
  taxRateBps: number,
): Promise<SaleReceiptFileRecord | null> {
  const meta = await readSoMeta(client, soId, taxRateBps);
  return meta.receiptFile;
}

export async function setSaleReceiptFile(
  client: InventreeClient,
  input: { soId: number; taxRateBps: number; file: SaleReceiptFileRecord; actor: string },
): Promise<SaleReceiptFileRecord | null> {
  const meta = await readSoMeta(client, input.soId, input.taxRateBps);
  const previous = meta.receiptFile;
  meta.receiptFile = input.file;
  await writeSoMeta(client, input.soId, meta);
  floorLog("receipt_upload", {
    so: input.soId,
    file: input.file.filename,
    actor: input.actor,
  });
  return previous;
}

export async function clearSaleReceiptFile(
  client: InventreeClient,
  input: { soId: number; taxRateBps: number; actor: string },
): Promise<SaleReceiptFileRecord | null> {
  const meta = await readSoMeta(client, input.soId, input.taxRateBps);
  const previous = meta.receiptFile;
  meta.receiptFile = null;
  await writeSoMeta(client, input.soId, meta);
  floorLog("receipt_delete", { so: input.soId, actor: input.actor });
  return previous;
}

