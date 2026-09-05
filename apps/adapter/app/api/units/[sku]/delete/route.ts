import { NextResponse } from "next/server";
import { hardDeleteUnit, loadUnitBySku } from "@floor/inventree";
import { inventreeClient } from "@/lib/inventree";
import { getSession } from "@/lib/session";
import { requireAdmin } from "@/lib/redact";
import { recordFate } from "@/lib/sku-ledger";

export async function POST(req: Request, ctx: { params: Promise<{ sku: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  try {
    requireAdmin(session.role);
    const { sku } = await ctx.params;
    const body = (await req.json()) as { typedSku?: string };
    const client = inventreeClient(session);
    const unit = await loadUnitBySku(client, sku);
    await hardDeleteUnit(client, {
      sku,
      typedSku: body.typedSku ?? "",
      actor: session.displayName,
    });
    recordFate(unit ?? { sku, brand: "", model: "", title: "" }, "hard-deleted");
    return NextResponse.json({ ok: true });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status });
  }
}
