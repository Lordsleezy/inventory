"use client";

import { useEffect, useState } from "react";

type BackupInfo = {
  ok: boolean;
  at: string | null;
  stale: boolean;
  ageHours: number | null;
  error?: string;
};

function formatBackupAt(at: string | null) {
  if (!at) return "never";
  const stamp = at.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  const date = stamp
    ? new Date(
        Date.UTC(
          Number(stamp[1]),
          Number(stamp[2]) - 1,
          Number(stamp[3]),
          Number(stamp[4]),
          Number(stamp[5]),
          Number(stamp[6]),
        ),
      )
    : new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function ageLabel(hours: number | null) {
  if (hours == null) return "";
  if (hours < 1) return "less than an hour ago";
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

export function HealthBanner() {
  const [down, setDown] = useState(false);
  const [detail, setDetail] = useState("");
  const [backup, setBackup] = useState<BackupInfo | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function ping() {
      try {
        const res = await fetch("/api/health");
        const data = await res.json();
        if (!cancelled) {
          setDown(data.backend !== "up");
          setDetail(data.detail ?? "");
          setBackup(data.backup ?? null);
          setReady(true);
        }
      } catch {
        if (!cancelled) {
          setDown(true);
          setDetail("unreachable");
          setReady(true);
        }
      }
    }
    void ping();
    const t = setInterval(ping, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const stale = Boolean(backup?.stale);
  if (!ready) return null;
  return (
    <>
      {down ? (
        <div className="sticky top-0 z-50 bg-floor-danger px-3 py-3 text-center text-body font-medium text-black">
          Backend unreachable. Nothing on screen is live. {detail}
        </div>
      ) : null}
      {stale ? (
        <div className="sticky top-0 z-50 bg-floor-danger px-3 py-3 text-center text-body font-medium text-black">
          {backup?.at
            ? `BACKUP OVERDUE — last copy ${ageLabel(backup.ageHours)} (${formatBackupAt(backup.at)}). Stock is not protected.`
            : "NO BACKUP ON RECORD — stock is not protected until one runs."}
        </div>
      ) : (
        <p className="px-3 py-1 text-center text-quiet text-floor-mute">
          Last backup {formatBackupAt(backup?.at ?? null)}
          {backup?.ageHours != null ? ` · ${ageLabel(backup.ageHours)}` : ""}
        </p>
      )}
    </>
  );
}
