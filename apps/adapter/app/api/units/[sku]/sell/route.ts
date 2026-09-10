import { NextResponse } from "next/server";
import { cannotSellReason, isSku, moneyStringToCents } from "@floor/domain";
import { loadUnitBySku, quickSell } from "@floor/inventree";
import { inventreeClient } from "@/lib/inventree";
import { getSession } from "@/lib/session";
import { loadFloorConfig } from "@/lib/config";
import { redactSale, redactUnit } from "@/lib/redact";
import { recordFate } from "@/lib/sku-ledger";

function fail(err: unknown) {
  const status = (err as { status?: number }).status ?? 500;
  return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status });
}

function money(body: Record<string, unknown>) {
  const raw = body.proceeds ?? body.price;
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  return moneyStringToCents(String(raw));
}

export async function POST(req: Request, ctx: { params: Promise<{ sku: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const { sku } = await ctx.params;
  if (!isSku(sku)) return NextResponse.json({ error: "SKU must be five digits" }, { status: 400 });
  const client = inventreeClient(session);
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const unit = await loadUnitBySku(client, sku);
    if (!unit) return NextResponse.json({ error: "No item with that SKU" }, { status: 404 });
    const blocked = cannotSellReason(unit);
    if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });
    const channel = String(body.channel ?? "").trim();
    const allowed = new Set([
      ...loadFloorConfig().channels.filter((row) => row.enabled).map((row) => row.id),
      "other",
    ]);
    if (!allowed.has(channel)) {
      return NextResponse.json({ error: "Pick a channel" }, { status: 400 });
    }
    const proceedsCents = money(body);
    if (proceedsCents === null) {
      return NextResponse.json({ error: "Enter what you actually got" }, { status: 400 });
    }
    const result = await quickSell(client, {
      sku,
      channel,
      proceedsCents,
      role: session.role,
      confirmBelowFloor: body.confirmBelowFloor === true,
      actor: session.displayName,
    });
    recordFate({ sku, brand: result.unit.brand, model: result.unit.model, title: result.unit.title }, "sold");
    return NextResponse.json({
      sale: redactSale(result.sale, session.role),
      unit: redactUnit(result.unit, session.role),
    });
  } catch (err) {
    return fail(err);
  }
}
