import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { floorRoot, inventreeUrl } from "@/lib/inventree";

const STALE_MS = 48 * 60 * 60 * 1000;

type BackupFile = {
  ok?: boolean;
  at?: string;
  file?: string;
  bytes?: number;
  reason?: string;
  error?: string;
};

function parseBackupAt(at: string): number | null {
  const stamp = at.trim();
  const m = stamp.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (m) {
    return Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    );
  }
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : null;
}

function readBackupFile(path: string): BackupFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BackupFile;
  } catch {
    return null;
  }
}

function loadBackupStatus() {
  const dir = process.env.FLOOR_BACKUP_DIR || "/var/backups/floor";
  const candidates = [
    process.env.FLOOR_BACKUP_STATUS,
    join(dir, "status.json"),
    join(floorRoot(), "data", "backup-status.json"),
  ].filter((path): path is string => Boolean(path));
  let raw: BackupFile | null = null;
  for (const path of candidates) {
    raw = readBackupFile(path);
    if (raw) break;
  }
  if (!raw?.at) {
    return { ok: false, at: null as string | null, file: "", stale: true, ageHours: null as number | null };
  }
  const ms = parseBackupAt(raw.at);
  const ageHours = ms == null ? null : (Date.now() - ms) / 3600000;
  const stale = !raw.ok || ms == null || Date.now() - ms > STALE_MS;
  return {
    ok: Boolean(raw.ok) && !stale,
    at: raw.at,
    file: raw.file ?? "",
    reason: raw.reason,
    error: raw.error,
    stale,
    ageHours,
  };
}

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
  const backup = loadBackupStatus();
  return NextResponse.json({ backend, detail, backup, live: backend === "up" });
}
