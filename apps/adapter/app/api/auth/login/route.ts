import { NextResponse } from "next/server";
import { loginWithPin, listStaffTiles } from "@/lib/staff";
import { encodeSession, sessionCookieOptions } from "@/lib/session";

export async function GET() {
  return NextResponse.json({ staff: listStaffTiles() });
}

export async function POST(req: Request) {
  const body = (await req.json()) as { username?: string; pin?: string };
  if (!body.username || !body.pin) {
    return NextResponse.json({ error: "Name and PIN required" }, { status: 400 });
  }
  try {
    const session = await loginWithPin(body.username, body.pin);
    const res = NextResponse.json({
      displayName: session.displayName,
      role: session.role,
    });
    res.cookies.set("floor_session", encodeSession(session), sessionCookieOptions());
    return res;
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : "Login failed";
    return NextResponse.json({ error: message }, { status });
  }
}
