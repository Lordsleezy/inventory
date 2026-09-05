import { NextResponse } from "next/server";
import { isSku } from "@floor/domain";
import { listStockAttachments, loadUnitBySku, setPrimaryPhoto } from "@floor/inventree";
import { inventreeClient } from "@/lib/inventree";
import { getSession } from "@/lib/session";
import { redactUnit } from "@/lib/redact";

function fail(err: unknown) {
  const status = (err as { status?: number }).status ?? 500;
  return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status });
}

export async function GET(_req: Request, ctx: { params: Promise<{ sku: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const { sku } = await ctx.params;
  if (!isSku(sku)) return NextResponse.json({ error: "SKU must be five digits" }, { status: 400 });
  const client = inventreeClient(session);
  const unit = await loadUnitBySku(client, sku);
  if (!unit?.stockId) return NextResponse.json({ error: "No item with that SKU" }, { status: 404 });
  const photos = await listStockAttachments(client, unit.stockId);
  return NextResponse.json({ unit: redactUnit(unit, session.role), photos });
}

export async function POST(req: Request, ctx: { params: Promise<{ sku: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const { sku } = await ctx.params;
  try {
    const body = (await req.json()) as { attachmentId?: number };
    const unit = await setPrimaryPhoto(inventreeClient(session), {
      sku,
      attachmentId: Number(body.attachmentId),
    });
    return NextResponse.json({ unit: unit ? redactUnit(unit, session.role) : null });
  } catch (err) {
    return fail(err);
  }
}
