import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import {
  authErrorMessage,
  floorCloud,
  loadAuthState,
  type AuthState,
} from "@floor/cloud";
import { Shell } from "./components/Shell";
import { Notice } from "./components/ui";
import { InventoryScreen } from "./screens/Inventory";
import { ReceiveScreen } from "./screens/Receive";
import { ReportsScreen } from "./screens/Reports";
import { SalesScreen } from "./screens/Sales";
import { SettingsScreen } from "./screens/Settings";
import { SetupScreen } from "./screens/Setup";
import { EmployeesScreen } from "./screens/Employees";
import { CategoriesScreen } from "./screens/Categories";
import { UnitScreen } from "./screens/Unit";
import { LoginScreen } from "./screens/Login";
import { SignupScreen } from "./screens/Signup";
import { CreateStoreScreen } from "./screens/CreateStore";
import { CheckoutScreen } from "./screens/Checkout";
import { DelistScreen } from "./screens/Delist";
import { ShipmentsScreen } from "./screens/Shipments";
import { PickupsScreen } from "./screens/Pickups";
import { IncidentsScreen } from "./screens/Incidents";
import { ConnectionsScreen } from "./screens/Connections";
import { ReaderProvider } from "./reader-host";
import { PinProvider } from "./pin";
import { StoreProvider, useStore } from "./store";

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { session } = useStore();
  if (session.role === "staff") return <Navigate to="/inventory" replace />;
  return children;
}

export function App() {
  const [auth, setAuth] = useState<AuthState | undefined>(undefined);
  const [bootError, setBootError] = useState("");
  const authRef = useRef<AuthState | undefined>(undefined);
  authRef.current = auth;
  const refreshGen = useRef(0);

  const refresh = useCallback(async (opts?: { allowSignedOut?: boolean }) => {
    const gen = ++refreshGen.current;
    try {
      const next = await loadAuthState();
      if (gen !== refreshGen.current) return;
      setAuth((current) => {
        // Only an explicit SIGNED_OUT event may drop a ready session. Async
        // Preferences + INITIAL_SESSION(null) used to bounce the phone to login
        // and remount StoreProvider (empty inventory / price flicker).
        if (
          next.kind === "signed_out" &&
          current?.kind === "ready" &&
          !opts?.allowSignedOut
        ) {
          return current;
        }
        return next;
      });
      setBootError("");
    } catch (err) {
      if (gen !== refreshGen.current) return;
      setBootError(authErrorMessage(err));
      setAuth((current) => current ?? { kind: "signed_out" });
    }
  }, []);

  useEffect(() => {
    let live = true;
    let unsub = () => {};
    const timer = window.setTimeout(() => {
      setAuth((current) => {
        if (current !== undefined) return current;
        setBootError("Floor is taking too long to open. Check Wi‑Fi and try again.");
        // Stay on the splash with retry — do not force login while auth is still unknown.
        return current;
      });
    }, 12_000);
    void (async () => {
      await refresh({ allowSignedOut: true });
      if (!live) return;
      try {
        // Capacitor Preferences storage is async. Supabase often emits
        // INITIAL_SESSION with session=null before the JWT is read — treating
        // that as signed_out is what logged the store phone in and out.
        const { data } = floorCloud().auth.onAuthStateChange((event) => {
          if (event === "SIGNED_OUT") {
            setAuth({ kind: "signed_out" });
            setBootError("");
            return;
          }
          if (
            event === "INITIAL_SESSION" ||
            event === "SIGNED_IN" ||
            event === "TOKEN_REFRESHED" ||
            event === "USER_UPDATED"
          ) {
            // INITIAL_SESSION must not be allowed to downgrade ready → signed_out.
            void refresh({
              allowSignedOut: event === "SIGNED_IN" || authRef.current?.kind !== "ready",
            });
          }
        });
        unsub = () => data.subscription.unsubscribe();
      } catch (err) {
        if (live) setBootError(authErrorMessage(err));
      }
    })();
    return () => {
      live = false;
      window.clearTimeout(timer);
      unsub();
    };
  }, [refresh]);

  if (auth === undefined) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-quiet text-floor-mute">
        <p>Floor</p>
        <Notice tone="error">{bootError}</Notice>
        {bootError ? (
          <button type="button" className="btn-accent mt-4" onClick={() => void refresh({ allowSignedOut: true })}>
            Try again
          </button>
        ) : null}
      </div>
    );
  }

  if (auth.kind === "signed_out") {
    return (
      <Routes>
        <Route path="/login" element={<LoginScreen onReady={() => void refresh({ allowSignedOut: true })} />} />
        <Route path="/signup" element={<SignupScreen />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (auth.kind === "needs_store") {
    return <CreateStoreScreen email={auth.email} onReady={() => void refresh({ allowSignedOut: true })} />;
  }

  return (
    <StoreProvider session={auth.session}>
      <PinProvider>
        <ReaderProvider>
          <Shell>
            <Routes>
              <Route path="/inventory" element={<InventoryScreen />} />
              <Route path="/inventory/:sku" element={<UnitScreen />} />
              <Route path="/checkout/:sku" element={<CheckoutScreen />} />
              <Route path="/receive" element={<ReceiveScreen />} />
              <Route path="/sales" element={<SalesScreen />} />
              <Route path="/shipments" element={<ShipmentsScreen />} />
              <Route path="/pickups" element={<PickupsScreen />} />
              <Route
                path="/reports"
                element={
                  <AdminOnly>
                    <ReportsScreen />
                  </AdminOnly>
                }
              />
              <Route
                path="/delist"
                element={
                  <AdminOnly>
                    <DelistScreen />
                  </AdminOnly>
                }
              />
              <Route path="/incidents" element={<IncidentsScreen />} />
              <Route
                path="/employees"
                element={
                  <AdminOnly>
                    <EmployeesScreen />
                  </AdminOnly>
                }
              />
              <Route path="/connections" element={<ConnectionsScreen />} />
              <Route path="/payment-device" element={<Navigate to="/settings" replace />} />
              <Route
                path="/setup"
                element={
                  <AdminOnly>
                    <SetupScreen />
                  </AdminOnly>
                }
              />
              <Route
                path="/setup/categories"
                element={
                  <AdminOnly>
                    <CategoriesScreen />
                  </AdminOnly>
                }
              />
              <Route path="/settings" element={<SettingsScreen />} />
              <Route path="*" element={<Navigate to="/inventory" replace />} />
            </Routes>
          </Shell>
        </ReaderProvider>
      </PinProvider>
    </StoreProvider>
  );
}
