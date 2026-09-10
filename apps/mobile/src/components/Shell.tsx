import { NavLink } from "react-router-dom";

const TABS = [
  { to: "/inventory", label: "Inventory" },
  { to: "/sales", label: "Sales" },
  { to: "/reports", label: "Reports" },
  { to: "/settings", label: "Setup" },
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-dvh max-w-md bg-floor-bg px-3 pb-10 pt-3 text-floor-text sm:px-4">
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-quiet tracking-[0.18em] text-floor-mute">FLOOR</p>
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {TABS.map((item) => (
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
      {children}
    </div>
  );
}
