import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** Bundled Capacitor UI (not the Surface website) calling JSON on this host. */
const NATIVE_ORIGINS = new Set([
  "capacitor://localhost",
  "ionic://localhost",
  "http://localhost",
  "https://localhost",
]);

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Floor-Session");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");
  if (origin && NATIVE_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  } else {
    headers.set("Access-Control-Allow-Origin", "*");
  }
  return headers;
}

export function middleware(req: NextRequest) {
  const origin = req.headers.get("origin");
  const extra = corsHeaders(origin);
  if (req.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: extra });
  }
  const res = NextResponse.next();
  extra.forEach((value, key) => res.headers.set(key, value));
  return res;
}

export const config = {
  matcher: "/api/:path*",
};
