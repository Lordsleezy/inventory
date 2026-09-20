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
import { CartScreen } from "./screens/Cart";
import { TenderScreen } from "./screens/Tender";
import { DoneScreen } from "./screens/Done";
import { LoginScreen } from "./screens/Login";
import { ReceiptsScreen } from "./screens/Receipts";
import { SettingsScreen } from "./screens/Settings";
import { InventoryScreen } from "./screens/Inventory";
import { UnitDetailScreen } from "./screens/UnitDetail";
import { ReceiveScreen } from "./screens/Receive";
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
      <CartProvider>
        <Shell />
      </CartProvider>
    </PosProvider>
  );
}

function Shell() {
  const { online, session, pendingOutbox, incidents, isAdmin, taxRateBps } = usePos();
  const { lines } = useCart();
  const navigate = useNavigate();

  return (
    <div className="shell">
      {!online ? <div className="offline">OFFLINE — reconnect before selling</div> : null}
      {taxRateBps == null ? (
        <div className="offline">TAX RATE NOT SET — open Settings (admin) before checkout</div>
      ) : null}
      {incidents.length ? (
        <div className="offline">INCIDENT — {incidents[0].sku}. Open Receipts.</div>
      ) : null}
      <header className="top">
        <strong>Floor register</strong>
        <nav className="nav">
          <Link to="/">Sell</Link>
          <Link to="/cart">Cart{lines.length ? ` (${lines.length})` : ""}</Link>
          <Link to="/inventory">Inventory</Link>
          <Link to="/receipts">Receipts{pendingOutbox ? ` (${pendingOutbox})` : ""}</Link>
          {isAdmin ? <Link to="/settings">Settings</Link> : null}
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
          <Route path="/cart" element={<CartScreen />} />
          <Route path="/tender" element={<TenderScreen />} />
          <Route path="/done/:ticketId" element={<DoneScreen />} />
          <Route path="/inventory" element={<InventoryScreen />} />
          <Route path="/inventory/receive" element={<ReceiveScreen />} />
          <Route path="/inventory/:sku" element={<UnitDetailScreen />} />
          <Route path="/receipts" element={<ReceiptsScreen />} />
          <Route path="/settings" element={isAdmin ? <SettingsScreen /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
