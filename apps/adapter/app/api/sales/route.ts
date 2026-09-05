import { NextResponse } from "next/server";
import { createSale, findSaleForSku, listCompletedSales, listOpenSales } from "@floor/inventree";
import { inventreeClient } from "@/lib/inventree";
import { getSession } from "@/lib/session";
import { loadFloorConfig } from "@/lib/config";
import { redactSale } from "@/lib/redact";
import { filterSaleHistory } from "@floor/domain";

function fail(err: unknown) {
  const status = (err as { status?: number }).status ?? 500;
  return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status });
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const url = new URL(req.url);
  const sku = url.searchParams.get("sku");
  const taxRateBps = loadFloorConfig().taxRateBps;
  try {
    const client = inventreeClient(session);
    if (url.searchParams.get("history") === "1") {
      const rows = await listCompletedSales(client, taxRateBps);
      return NextResponse.json({ sales: filterSaleHistory(rows, url.searchParams.get("q") ?? "") });
    }
    if (sku) {
      const sale = await findSaleForSku(client, sku, taxRateBps);
      return NextResponse.json({ sale: redactSale(sale, session.role) });
    }
    const sales = (await listOpenSales(client, taxRateBps)).map((sale) => redactSale(sale, session.role));
    return NextResponse.json({ sales });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const sale = await createSale(inventreeClient(session), {
      customer: {
        name: body.name ? String(body.name) : null,
        phone: body.phone ? String(body.phone) : null,
        email: body.email ? String(body.email) : null,
      },
      taxRateBps: loadFloorConfig().taxRateBps,
      actor: session.displayName,
    });
    return NextResponse.json({ sale: redactSale(sale, session.role) });
  } catch (err) {
    return fail(err);
  }
}
