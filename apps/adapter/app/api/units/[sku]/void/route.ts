import { NextResponse } from "next/server";
import { voidUnit } from "@floor/inventree";
import { inventreeClient } from "@/lib/inventree";
import { getSession } from "@/lib/session";
import { redactUnit } from "@/lib/redact";
import { recordFate } from "@/lib/sku-ledger";

export async function POST(req: Request, ctx: { params: Promise<{ sku: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const { sku } = await ctx.params;
  const body = (await req.json()) as { reason?: string };
  try {
    const unit = await voidUnit(inventreeClient(session), {
      sku,
      reason: body.reason ?? "",
      actor: session.displayName,
    });
    recordFate(unit, "voided");
    return NextResponse.json({ unit: redactUnit(unit, session.role) });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status });
  }
}
