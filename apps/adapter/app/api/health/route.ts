import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { floorRoot, inventreeUrl } from "@/lib/inventree";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  let backend: "up" | "down" = "down";
  let detail = "";
  try {
    const res = await fetch(`${inventreeUrl()}/api/`, { cache: "no-store" });
    backend = res.ok ? "up" : "down";
    if (!res.ok) detail = `HTTP ${res.status}`;
  } catch (err) {
    backend = "down";
    detail = err instanceof Error ? err.message : "unreachable";
  }
  let backup: { ok: boolean; at: string; file: string } | null = null;
  const statusPath = join(floorRoot(), "data", "backup-status.json");
  if (existsSync(statusPath)) {
    try {
      backup = JSON.parse(readFileSync(statusPath, "utf8"));
    } catch {
      backup = null;
    }
  }
  return NextResponse.json({ backend, detail, backup, live: backend === "up" });
}
