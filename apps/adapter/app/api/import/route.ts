import { NextResponse } from "next/server";
import { commitImportRows, guessColumnMap, parseCsv, parseImportRow, type ColumnMap } from "@floor/importer";
import { inventreeClient } from "@/lib/inventree";
import { getSession } from "@/lib/session";
import { loadFloorConfig } from "@/lib/config";
import { requireAdmin } from "@/lib/redact";
import { recordIssued, loadSkuLedger } from "@/lib/sku-ledger";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  try {
    requireAdmin(session.role);
    const body = (await req.json()) as { csv?: string; map?: ColumnMap; commit?: boolean };
    if (!body.csv) return NextResponse.json({ error: "CSV required" }, { status: 400 });
    const table = parseCsv(body.csv);
    const map = body.map ?? guessColumnMap(table.headers);
    const parsed = table.rows.map((values, i) => parseImportRow(table.headers, values, map, i + 2));
    if (!body.commit) {
      return NextResponse.json({
        headers: table.headers,
        map,
        preview: parsed,
        counts: {
          rows: parsed.length,
          errors: parsed.filter((r) => r.error).length,
        },
      });
    }
    const client = inventreeClient(session);
    const ledger = loadSkuLedger();
    const results = await commitImportRows(
      client,
      parsed,
      loadFloorConfig().skuStart,
      session.displayName,
      Object.values(ledger.entries),
      (unit) => recordIssued(unit),
    );
    return NextResponse.json({
      results,
      created: results.filter((r) => r.status === "created").length,
      errors: results.filter((r) => r.status === "error").length,
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status });
  }
}
