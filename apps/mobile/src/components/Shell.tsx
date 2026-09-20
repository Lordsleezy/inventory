import { NavLink } from "react-router-dom";
import { useStore } from "../store";

export function Shell({ children }: { children: React.ReactNode }) {
  const { online, cloudError, delistCount, incidentCount } = useStore();

  const tabs = [
    { to: "/inventory", label: "Inventory" },
    { to: "/sales", label: "Sales" },
    { to: "/delist", label: `Delist${delistCount ? ` (${delistCount})` : ""}` },
    { to: "/reports", label: "Reports" },
    { to: "/settings", label: "Setup" },
  ];

  return (
    <div
      className="mx-auto min-h-dvh max-w-md bg-floor-bg px-3 text-floor-text sm:px-4"
      style={{
        paddingTop: "max(0.75rem, env(safe-area-inset-top))",
        paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))",
      }}
    >
      <header className="mb-3 flex items-start gap-3">
        <p className="shrink-0 pt-1 text-quiet tracking-[0.18em] text-floor-mute">FLOOR</p>
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          {tabs.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `min-h-touch px-0.5 text-body ${isActive ? "text-floor-text" : "text-floor-mute"}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
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
