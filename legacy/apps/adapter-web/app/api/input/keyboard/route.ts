import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isTabletMode } from "@/lib/tablet";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  return NextResponse.json({ tablet: isTabletMode() });
}
