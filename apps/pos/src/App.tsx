import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  authErrorMessage,
  floorCloud,
  isNetworkAuthFailure,
  loadAuthState,
  setDeviceNetworkGetter,
  type StaffSession,
} from "@floor/cloud";
import { RegisterScreen } from "./screens/Register";
import { DoneScreen } from "./screens/Done";
import { LoginScreen } from "./screens/Login";
import { ReceiptsScreen } from "./screens/Receipts";
import { ReportsScreen } from "./screens/Reports";
import { EmployeesScreen } from "./screens/Employees";
import { SettingsScreen } from "./screens/Settings";
import { AccountScreen } from "./screens/Account";
import { InventoryScreen } from "./screens/Inventory";
import { UnitDetailScreen } from "./screens/UnitDetail";
import { ReceiveScreen } from "./screens/Receive";
import { ReceiptDesignerScreen } from "./screens/ReceiptDesigner";
import { PosProvider, usePos } from "./pos-context";
import { CartProvider, useCart } from "./cart";

setDeviceNetworkGetter(async () => ({
  connected: typeof navigator === "undefined" ? true : navigator.onLine,
  connectionType: "unknown",
}));

function hasCloudEnv(): boolean {
  return Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
}

export function App() {
  const [session, setSession] = useState<StaffSession | null>(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState("");
  const [networkHint, setNetworkHint] = useState(false);
  const [storeOsAccount, setStoreOsAccount] = useState(false);

  useEffect(() => {
    let alive = true;
    let unsubscribe = () => {};
    void (async () => {
      if (!hasCloudEnv()) {
        setBooting(false);
        setError("This register build is missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.");
        return;
      }
      const storeAccount = await invoke<boolean>("is_store_os_account").catch(() => false);
      if (!alive) return;
      setStoreOsAccount(storeAccount);
      const sb = floorCloud();
      if (storeAccount) await sb.auth.signOut({ scope: "local" });
      const { data } = sb.auth.onAuthStateChange(() => { void refresh(); });
      unsubscribe = () => data.subscription.unsubscribe();
      await refresh();
    })().catch((err) => {
      if (!alive) return;
      setError(authErrorMessage(err));
      setNetworkHint(isNetworkAuthFailure(err));
      setBooting(false);
    });
    return () => { alive = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F11" || storeOsAccount) return;
      event.preventDefault();
      void invoke("toggle_fullscreen");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [storeOsAccount]);

  async function refresh() {
    try {
      const state = await loadAuthState();
      setSession(state.kind === "ready" ? state.session : null);
      setError(state.kind === "needs_store" ? "This account is not attached to a store." : "");
      setNetworkHint(false);
    } catch (err) {
      setError(authErrorMessage(err));
      setNetworkHint(isNetworkAuthFailure(err));
      setSession(null);
    } finally {
      setBooting(false);
    }
  }

  if (booting) return <p className="page">Starting register…</p>;
  if (!session) {
    return (
      <div className="login-shell">
        {error ? <p className="error" style={{ textAlign: "center" }}>{error}</p> : null}
        {networkHint ? (
          <p className="muted" style={{ textAlign: "center", maxWidth: 420 }}>
            If Wi‑Fi looks fine, open a browser on this Mac and load the Supabase host, then try again.
          </p>
        ) : null}
        {hasCloudEnv() ? <LoginScreen /> : null}
      </div>
    );
  }

  return (
    <PosProvider session={session}>
      <CartProvider>
        <Shell />
      </CartProvider>
    </PosProvider>
  );
}

function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span>{now.toLocaleString()}</span>;
}

function Shell() {
  const { online, session, pendingOutbox, incidents, isAdmin, taxRateBps, rewards } = usePos();
  const { ticketId, lines } = useCart();
  const navigate = useNavigate();
  const location = useLocation();
  const onRegister = location.pathname === "/";

  async function signOut() {
    await floorCloud().auth.signOut({ scope: "local" });
    navigate("/");
  }

  return (
    <div className="shell">
      {!online ? <div className="offline">OFFLINE — reconnect before selling</div> : null}
      {taxRateBps == null ? (
        <div className="offline warn">TAX RATE NOT SET — open Settings (admin) before checkout</div>
      ) : null}
      {incidents.length ? (
        <div className="offline">INCIDENT — {incidents[0].sku}. Open Receipts.</div>
      ) : null}
      <header className="top">
        <div className="top-brand">{rewards.storeDisplayName || "Floor"}</div>
        <div className="top-meta">
          {onRegister ? (
            <span>
              Order #{ticketId.slice(0, 8)}
              {lines.length ? ` · ${lines.length} line${lines.length === 1 ? "" : "s"}` : ""}
            </span>
          ) : (
            <span className="muted">{location.pathname}</span>
          )}
          <LiveClock />
        </div>
        <details className="clerk-menu">
          <summary>
            {session.displayName} ▾
          </summary>
          <div className="clerk-menu-panel">
            <button type="button" onClick={() => void signOut()}>
              Sign out
            </button>
            <button type="button" onClick={() => navigate("/settings")}>
              Settings
            </button>
            {isAdmin ? (
              <button type="button" onClick={() => navigate("/setup")}>
                Setup
              </button>
            ) : null}
          </div>
        </details>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<RegisterScreen />} />
          <Route path="/cart" element={<Navigate to="/" replace />} />
          <Route path="/tender" element={<Navigate to="/" replace />} />
          <Route path="/done/:ticketId" element={<DoneScreen />} />
          <Route path="/inventory" element={<InventoryScreen />} />
          <Route path="/inventory/receive" element={<ReceiveScreen />} />
          <Route path="/inventory/:sku" element={<UnitDetailScreen />} />
          <Route path="/receipts" element={<ReceiptsScreen />} />
          <Route path="/reports" element={isAdmin ? <ReportsScreen /> : <Navigate to="/" replace />} />
          <Route path="/employees" element={isAdmin ? <EmployeesScreen /> : <Navigate to="/" replace />} />
          <Route path="/setup" element={isAdmin ? <SettingsScreen /> : <Navigate to="/" replace />} />
          <Route
            path="/setup/receipt"
            element={isAdmin ? <ReceiptDesignerScreen /> : <Navigate to="/" replace />}
          />
          <Route path="/settings" element={<AccountScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <nav className="bottom-nav">
        {isAdmin ? <Link to="/setup">Setup</Link> : null}
        {isAdmin ? <Link to="/employees">Employees</Link> : null}
        {isAdmin ? <Link to="/reports">Reports</Link> : null}
        <Link to="/receipts">Receipts{pendingOutbox ? ` (${pendingOutbox})` : ""}</Link>
        <Link to="/inventory">Inventory</Link>
        {!onRegister ? <Link to="/">Register</Link> : null}
        <Link to="/settings">Settings</Link>
      </nav>
    </div>
  );
}
