import { NextResponse } from "next/server";
import { moneyStringToCents } from "@floor/domain";
import {
  addSaleItem,
  cancelSale,
  completeSale,
  loadSale,
  parkSale,
  removeSaleItem,
  returnSaleItem,
  setSaleCustomer,
  setSaleDiscount,
  setSaleLinePrice,
} from "@floor/inventree";
import { inventreeClient } from "@/lib/inventree";
import { getSession } from "@/lib/session";
import { loadFloorConfig } from "@/lib/config";
import { redactSale, redactUnit } from "@/lib/redact";
import { recordFate } from "@/lib/sku-ledger";

function fail(err: unknown) {
  const status = (err as { status?: number }).status ?? 500;
  return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status });
}

function money(body: Record<string, unknown>, key: string) {
  const raw = body[key];
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  return moneyStringToCents(String(raw));
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const { id } = await ctx.params;
  const soId = Number(id);
  if (!Number.isInteger(soId)) return NextResponse.json({ error: "Bad sale" }, { status: 400 });
  try {
    const sale = await loadSale(inventreeClient(session), soId, loadFloorConfig().taxRateBps);
    return NextResponse.json({ sale: redactSale(sale, session.role) });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const { id } = await ctx.params;
  const soId = Number(id);
  if (!Number.isInteger(soId)) return NextResponse.json({ error: "Bad sale" }, { status: 400 });
  const taxRateBps = loadFloorConfig().taxRateBps;
  const client = inventreeClient(session);
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const op = String(body.op ?? "");
    const confirmBelowFloor = body.confirmBelowFloor === true;
    if (op === "add") {
      const sale = await addSaleItem(client, {
        soId,
        sku: String(body.sku ?? ""),
        priceCents: money(body, "price"),
        taxRateBps,
        role: session.role,
        confirmBelowFloor,
        actor: session.displayName,
      });
      return NextResponse.json({ sale: redactSale(sale, session.role) });
    }
    if (op === "remove") {
      const sale = await removeSaleItem(client, {
        soId,
        sku: String(body.sku ?? ""),
        taxRateBps,
        actor: session.displayName,
      });
      return NextResponse.json({ sale: redactSale(sale, session.role) });
    }
    if (op === "price") {
      const priceCents = money(body, "price");
      if (priceCents === null) return NextResponse.json({ error: "Enter a price" }, { status: 400 });
      const sale = await setSaleLinePrice(client, {
        soId,
        sku: String(body.sku ?? ""),
        priceCents,
        taxRateBps,
        role: session.role,
        confirmBelowFloor,
      });
      return NextResponse.json({ sale: redactSale(sale, session.role) });
    }
    if (op === "discount") {
      const saleDiscountCents = money(body, "discount") ?? 0;
      const sale = await setSaleDiscount(client, { soId, saleDiscountCents, taxRateBps });
      return NextResponse.json({ sale: redactSale(sale, session.role) });
    }
    if (op === "customer") {
      const sale = await setSaleCustomer(client, {
        soId,
        customer: {
          name: body.name ? String(body.name) : null,
          phone: body.phone ? String(body.phone) : null,
          email: body.email ? String(body.email) : null,
        },
        taxRateBps,
      });
      return NextResponse.json({ sale: redactSale(sale, session.role) });
    }
    if (op === "park") {
      const sale = await parkSale(client, { soId, taxRateBps, actor: session.displayName });
      return NextResponse.json({ sale: redactSale(sale, session.role) });
    }
    if (op === "complete") {
      const sale = await completeSale(client, {
        soId,
        taxRateBps,
        paymentMethod: String(body.paymentMethod ?? ""),
        role: session.role,
        confirmBelowFloor,
        actor: session.displayName,
      });
      for (const line of sale.lines) {
        recordFate({ sku: line.sku, brand: "", model: "", title: line.title }, "sold");
      }
      return NextResponse.json({ sale: redactSale(sale, session.role) });
    }
    if (op === "cancel") {
      const sale = await cancelSale(client, { soId, taxRateBps, actor: session.displayName });
      return NextResponse.json({ sale: redactSale(sale, session.role) });
    }
    if (op === "return") {
      const result = await returnSaleItem(client, {
        soId,
        sku: String(body.sku ?? ""),
        restock: String(body.restock ?? ""),
        reason: String(body.reason ?? ""),
        taxRateBps,
        actor: session.displayName,
      });
      return NextResponse.json({
        sale: redactSale(result.sale, session.role),
        unit: redactUnit(result.unit, session.role),
      });
    }
    return NextResponse.json({ error: "Unknown op" }, { status: 400 });
  } catch (err) {
    return fail(err);
  }
}
