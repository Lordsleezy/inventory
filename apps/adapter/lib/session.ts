import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";

export type FloorRole = "admin" | "staff";

export type FloorSession = {
  token: string;
  username: string;
  displayName: string;
  role: FloorRole;
};

function secret() {
  return process.env.FLOOR_SESSION_SECRET || "dev-only-change-me";
}

export function encodeSession(session: FloorSession): string {
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function decodeSession(raw: string | undefined): FloorSession | null {
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as FloorSession;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<FloorSession | null> {
  const jar = await cookies();
  const fromCookie = decodeSession(jar.get("floor_session")?.value);
  if (fromCookie) return fromCookie;
  const h = await headers();
  const auth = h.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) {
    return decodeSession(auth.replace(/^bearer\s+/i, "").trim());
  }
  return decodeSession(h.get("x-floor-session") ?? undefined);
}

export function sessionCookieOptions(maxAge = 60 * 60 * 12) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: false,
    path: "/",
    maxAge,
  };
}

export async function requireSession(): Promise<FloorSession> {
  const session = await getSession();
  if (!session) {
    const err = new Error("unauthorized");
    (err as Error & { status: number }).status = 401;
    throw err;
  }
  return session;
}
