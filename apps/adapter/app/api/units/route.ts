import { NextResponse } from "next/server";
import { isSku, moneyStringToCents, type UnitQuery } from "@floor/domain";
import { descriptiveHintForModel, nextSku, receiveUnit, searchUnits } from "@floor/inventree";
import { inventreeClient } from "@/lib/inventree";
import { getSession } from "@/lib/session";
import { loadFloorConfig } from "@/lib/config";
import { redactUnit } from "@/lib/redact";
import { assertSkuAvailable, ledgerOccupied, loadSkuLedger, recordIssued } from "@/lib/sku-ledger";

function fail(err: unknown) {
  const status = (err as { status?: number }).status ?? 500;
  return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status });
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const url = new URL(req.url);
  const client = inventreeClient(session);
  const checkSku = url.searchParams.get("checkSku");
  if (checkSku) {
    if (!isSku(checkSku)) {
      return NextResponse.json({ ok: false, error: "SKU must be five digits" }, { status: 400 });
    }
    try {
      await assertSkuAvailable(client, checkSku);
      return NextResponse.json({ ok: true });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Failed" }, { status });
    }
  }
  if (url.searchParams.get("next") === "1") {
    const sku = await nextSku(client, loadFloorConfig().skuStart, ledgerOccupied());
    return NextResponse.json({ sku });
  }
  const model = url.searchParams.get("model");
  if (model) {
    const hint = await descriptiveHintForModel(client, model);
    return NextResponse.json({ hint });
  }
  const query: UnitQuery = {
    q: url.searchParams.get("q") ?? undefined,
    queue: (url.searchParams.get("queue") as UnitQuery["queue"]) ?? undefined,
    includeVoided: url.searchParams.get("includeVoided") === "1",
  };
  const units = (await searchUnits(client, query)).map((u) => redactUnit(u, session.role));
  return NextResponse.json({ units });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const acquisition =
      typeof body.acquisition === "string" || typeof body.acquisition === "number"
        ? moneyStringToCents(body.acquisition as string)
        : null;
    const client = inventreeClient(session);
    const requested = body.sku ? String(body.sku).trim() : "";
    if (requested) {
      if (!isSku(requested)) {
        return NextResponse.json({ error: "SKU must be five digits" }, { status: 400 });
      }
      await assertSkuAvailable(client, requested);
    }
    const unit = await receiveUnit(client, {
      brand: String(body.brand ?? ""),
      model: String(body.model ?? ""),
      title: String(body.title ?? ""),
      category: String(body.category ?? ""),
      lot: body.lot ? String(body.lot) : null,
      acquisitionCostCents: acquisition,
      skuStart: loadFloorConfig().skuStart,
      sku: requested || undefined,
      occupied: Object.values(loadSkuLedger().entries),
    });
    recordIssued(unit);
    return NextResponse.json({ unit: redactUnit(unit, session.role) });
  } catch (err) {
    return fail(err);
  }
}
