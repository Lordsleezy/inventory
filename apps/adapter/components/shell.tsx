"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { HealthBanner } from "./health-banner";

const NAV = [
  { href: "/sell", label: "Sell", ready: true },
  { href: "/inventory", label: "Inventory", ready: true },
  { href: "/receive", label: "Receive", ready: true },
  { href: "/price", label: "Price", ready: true },
  { href: "/list-online", label: "List online", ready: true },
  { href: "/reports", label: "Reports", ready: true },
] as const;

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [name, setName] = useState("");

  useEffect(() => {
    fetch("/api/auth/me")
      .then(async (res) => {
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        const data = await res.json();
        setName(data.user?.displayName ?? "");
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  return (
    <div className="min-h-screen bg-floor-bg text-floor-text">
      <HealthBanner />
      <header className="border-b border-floor-line bg-floor-panel px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-lg font-black tracking-wide text-floor-accent">FLOOR</p>
          <p className="text-sm text-floor-mute">{name}</p>
          <button
            type="button"
            onClick={logout}
            className="min-h-touch min-w-touch rounded-lg border border-floor-line px-3 text-sm font-semibold"
          >
            Sign out
          </button>
        </div>
        <nav className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            if (!item.ready) {
              return (
                <span
                  key={item.href}
                  className="flex min-h-touch items-center justify-center rounded-lg border border-floor-line bg-black/30 px-2 text-center text-sm font-bold uppercase tracking-wide text-floor-mute"
                >
                  {item.label}
                </span>
              );
            }
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex min-h-touch items-center justify-center rounded-lg border px-2 text-center text-sm font-bold uppercase tracking-wide ${
                  active
                    ? "border-floor-accent bg-floor-accent text-black"
                    : "border-floor-line bg-black/40 text-floor-text"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="p-3">{children}</main>
    </div>
  );
}
