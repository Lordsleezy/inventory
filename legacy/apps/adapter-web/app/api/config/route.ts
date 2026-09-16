import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { loadFloorConfig } from "@/lib/config";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const config = loadFloorConfig();
  return NextResponse.json({
    config,
    role: session.role,
  });
}
