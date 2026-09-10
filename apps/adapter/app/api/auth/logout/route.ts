import { NextResponse } from "next/server";
import { sessionCookieOptions } from "@/lib/session";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("floor_session", "", { ...sessionCookieOptions(0), maxAge: 0 });
  return res;
}
