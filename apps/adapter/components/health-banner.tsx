"use client";

import { useEffect, useState } from "react";

export function HealthBanner() {
  const [down, setDown] = useState(false);
  const [detail, setDetail] = useState("");
  useEffect(() => {
    let cancelled = false;
    async function ping() {
      try {
        const res = await fetch("/api/health");
        const data = await res.json();
        if (!cancelled) {
          setDown(data.backend !== "up");
          setDetail(data.detail ?? "");
        }
      } catch {
        if (!cancelled) {
          setDown(true);
          setDetail("unreachable");
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
  if (!down) return null;
  return (
    <div className="bg-floor-danger px-3 py-2 text-center text-sm font-black text-black">
      Backend unreachable. Nothing on screen is live. {detail}
    </div>
  );
}
