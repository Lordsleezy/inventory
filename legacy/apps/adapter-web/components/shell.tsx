"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { HealthBanner } from "./health-banner";
import { OnScreenKeyboard } from "./on-screen-keyboard";

const TABS = [
  { href: "/inventory", label: "Inventory" },
  { href: "/receive", label: "Receive" },
  { href: "/reports", label: "Reports" },
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

  const onRegister = pathname.startsWith("/sell");

  return (
    <div className="min-h-screen bg-floor-bg text-floor-text">
      <HealthBanner />
      <header className="px-3 pt-3 pb-2 sm:px-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-quiet tracking-[0.18em] text-floor-mute">FLOOR</p>
          <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {TABS.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`inline-flex min-h-touch items-center px-2 text-body ${
                    active && !onRegister ? "text-floor-accent" : "text-floor-mute"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <Link
            href="/sell"
            className={`inline-flex min-h-touch items-center px-2 text-quiet ${
              onRegister ? "text-floor-accent" : "text-floor-mute"
            }`}
          >
            Register
          </Link>
          <p className="hidden text-quiet text-floor-mute sm:block">{name}</p>
          <button type="button" onClick={logout} className="btn-text px-2 text-quiet">
            Sign out
          </button>
        </div>
      </header>
      <main className="min-w-0 px-3 pb-8 pt-2 sm:px-4">{children}</main>
      <OnScreenKeyboard />
    </div>
  );
}
