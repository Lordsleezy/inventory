import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useStore } from "../store";

type Item = { to: string; label: string };

export function Shell({ children }: { children: React.ReactNode }) {
  const { online, cloudError, delistCount, incidentCount, session } = useStore();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const admin = session.role !== "staff";

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const items: Item[] = [
    { to: "/inventory", label: "Inventory" },
    { to: "/shipments", label: "Shipments" },
    { to: "/sales", label: "Sales" },
    ...(admin
      ? [
          { to: "/delist", label: `Delist${delistCount ? ` (${delistCount})` : ""}` },
          { to: "/reports", label: "Reports" },
          { to: "/employees", label: "Employees" },
          { to: "/setup", label: "Setup" },
        ]
      : []),
    { to: "/settings", label: "Settings" },
  ];

  return (
    <div
      className="mx-auto min-h-dvh max-w-md bg-floor-bg px-3 text-floor-text sm:px-4"
      style={{
        paddingTop: "max(0.75rem, env(safe-area-inset-top))",
        paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))",
      }}
    >
      <header className="mb-3 flex items-center gap-3">
        <button
          type="button"
          className="flex min-h-touch w-11 flex-col items-center justify-center gap-[5px] px-2"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="block h-0.5 w-5 bg-floor-text" />
          <span className="block h-0.5 w-5 bg-floor-text" />
          <span className="block h-0.5 w-5 bg-floor-text" />
        </button>
        <p className="pt-1 text-quiet tracking-[0.18em] text-floor-mute">FLOOR</p>
      </header>

      {open ? (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Menu">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          />
          <nav
            className="absolute bottom-0 left-0 top-0 flex w-64 max-w-[80vw] flex-col border-r border-floor-line bg-floor-bg px-3"
            style={{
              paddingTop: "max(0.75rem, env(safe-area-inset-top))",
              paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
            }}
          >
            <div className="mb-2 flex items-center gap-3">
              <button
                type="button"
                className="flex min-h-touch w-11 items-center justify-center px-2 text-title"
                aria-label="Close menu"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
              <p className="pt-1 text-quiet tracking-[0.18em] text-floor-mute">FLOOR</p>
            </div>
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex min-h-touch items-center border-b border-floor-line text-body ${
                    isActive ? "text-floor-accent" : "text-floor-text"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
            <p className="mt-auto text-quiet text-floor-mute">
              {session.displayName} · {session.role}
            </p>
          </nav>
        </div>
      ) : null}

      {!online ? (
        <p className="mb-3 border border-floor-line p-2 text-quiet text-floor-danger">
          Offline — browsing only. Connect to the internet to sell or add units.
        </p>
      ) : cloudError ? (
        <p className="mb-3 border border-floor-line p-2 text-quiet text-floor-danger">
          Cloud: {cloudError}
        </p>
      ) : null}
      {incidentCount > 0 ? (
        <NavLink to="/incidents" className="mb-3 block border border-floor-danger p-3 text-body text-floor-danger">
          DOUBLE SALE / INCIDENT — {incidentCount} open. Do not take money.
        </NavLink>
      ) : null}
      {children}
    </div>
  );
}
