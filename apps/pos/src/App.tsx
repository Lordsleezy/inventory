import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import {
  authErrorMessage,
  floorCloud,
  loadAuthState,
  setDeviceNetworkGetter,
  type StaffSession,
} from "@floor/cloud";
import { hasAdminPin, verifyAdminPin } from "./local";
import { BrowseScreen } from "./screens/Browse";
import { CheckoutScreen } from "./screens/Checkout";
import { LoginScreen } from "./screens/Login";
import { ReceiptsScreen } from "./screens/Receipts";
import { SettingsScreen } from "./screens/Settings";
import { EmployeesScreen } from "./screens/Employees";
import { PosProvider, usePos } from "./pos-context";

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

  useEffect(() => {
    if (!hasCloudEnv()) {
      setBooting(false);
      setError("This register build is missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.");
      return;
    }
    const sb = floorCloud();
    const { data } = sb.auth.onAuthStateChange(() => {
      void refresh();
    });
    void refresh();
    return () => data.subscription.unsubscribe();
  }, []);

  async function refresh() {
    try {
      const state = await loadAuthState();
      setSession(state.kind === "ready" ? state.session : null);
      setError(state.kind === "needs_store" ? "This account is not attached to a store." : "");
    } catch (err) {
      setError(authErrorMessage(err));
      setSession(null);
    } finally {
      setBooting(false);
    }
  }

  if (booting) return <p className="page">Starting register…</p>;
  if (!session) {
    return (
      <div className="page">
        {error ? <p className="error">{error}</p> : null}
        {hasCloudEnv() ? <LoginScreen /> : null}
      </div>
    );
  }

  return (
    <PosProvider session={session}>
      <Shell />
    </PosProvider>
  );
}

function Shell() {
  const { online, session, pendingOutbox, incidents } = usePos();
  const navigate = useNavigate();
  const isAdmin = session.role === "owner" || session.role === "manager";

  return (
    <div className="shell">
      {!online ? <div className="offline">OFFLINE — cash only</div> : null}
      {incidents.length ? (
        <div className="offline">INCIDENT — cash taken on {incidents[0].sku}. Open Receipts.</div>
      ) : null}
      <header className="top">
        <strong>Floor register</strong>
        <nav className="nav">
          <Link to="/">Search</Link>
          <Link to="/receipts">Receipts{pendingOutbox ? ` (${pendingOutbox})` : ""}</Link>
          {isAdmin ? <Link to="/employees">Employees</Link> : null}
          <Link to="/settings">Settings</Link>
        </nav>
        <span className="muted">
          {session.displayName} · {isAdmin ? "admin" : "clerk"}
        </span>
        <button
          type="button"
          onClick={() => {
            void (async () => {
              if (await hasAdminPin()) {
                const pin = window.prompt("Admin PIN");
                if (!pin || !(await verifyAdminPin(pin))) return;
              }
              await floorCloud().auth.signOut();
              navigate("/");
            })();
          }}
        >
          Switch clerk
        </button>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<BrowseScreen />} />
          <Route path="/checkout/:sku" element={<CheckoutScreen />} />
          <Route path="/receipts" element={<ReceiptsScreen />} />
          <Route path="/employees" element={<EmployeesScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
