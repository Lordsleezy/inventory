import { NavLink } from "react-router-dom";
import { useStore } from "../store";

export function Shell({ children }: { children: React.ReactNode }) {
  const { session, online, delistCount, incidentCount } = useStore();
  const isStaff = session.role === "staff";

  const tabs = [
    { to: "/inventory", label: "Inventory" },
    { to: "/sales", label: "Sales" },
    { to: "/delist", label: `Delist${delistCount ? ` (${delistCount})` : ""}` },
    ...(isStaff ? [] : [{ to: "/reports", label: "Reports" }]),
    { to: "/settings", label: "Setup" },
  ];

  return (
    <div className="mx-auto min-h-dvh max-w-md bg-floor-bg px-3 pb-10 pt-3 text-floor-text sm:px-4">
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-quiet tracking-[0.18em] text-floor-mute">FLOOR</p>
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {tabs.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `min-h-touch px-1 text-body ${isActive ? "text-floor-text" : "text-floor-mute"}`
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
