import { NextResponse } from "next/server";

/** Unauthenticated reachability check for the bundled iOS app. No stock data. */
export async function GET() {
  return NextResponse.json({ ok: true, service: "floor" });
}
