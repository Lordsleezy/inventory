import { NavLink, useNavigate } from "react-router-dom";
import { setToken } from "../api";

const TABS = [
  { to: "/inventory", label: "Inventory" },
  { to: "/reports", label: "Reports" },
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();

  function logout() {
    setToken("");
    navigate("/login", { replace: true });
  }

  return (
    <div className="mx-auto min-h-dvh max-w-md bg-floor-bg px-3 pb-8 pt-3 text-floor-text sm:px-4">
      <header className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-quiet tracking-[0.18em] text-floor-mute">FLOOR</p>
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
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
        <button type="button" onClick={logout} className="btn-text px-0">
          Sign out
        </button>
      </header>
      {children}
    </div>
  );
}
