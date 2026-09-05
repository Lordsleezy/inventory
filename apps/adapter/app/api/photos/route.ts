import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { inventreeClient } from "@/lib/inventree";
import { loadFloorConfig } from "@/lib/config";
import { ingestDropFolder, listUnmatched } from "@/lib/photo-drop";

function fail(err: unknown) {
  const status = (err as { status?: number }).status ?? 500;
  return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status });
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const drop = loadFloorConfig().photoDropPath;
  return NextResponse.json({
    watching: Boolean(drop),
    dropPath: drop || null,
    unmatched: drop ? listUnmatched(drop) : [],
  });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  try {
    const body = (await req.json().catch(() => ({}))) as { dir?: string };
    const drop = body.dir || loadFloorConfig().photoDropPath;
    const results = await ingestDropFolder(inventreeClient(session), drop, session.displayName);
    return NextResponse.json({ results, unmatched: listUnmatched(drop) });
  } catch (err) {
    return fail(err);
  }
}
