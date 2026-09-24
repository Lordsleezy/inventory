import { useCallback, useEffect, useState } from "react";
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
import { EmployeesScreen } from "./screens/Employees";
import { CategoriesScreen } from "./screens/Categories";
import { UnitScreen } from "./screens/Unit";
import { LoginScreen } from "./screens/Login";
import { SignupScreen } from "./screens/Signup";
import { CreateStoreScreen } from "./screens/CreateStore";
import { CheckoutScreen } from "./screens/Checkout";
import { DelistScreen } from "./screens/Delist";
import { ShipmentsScreen } from "./screens/Shipments";
import { IncidentsScreen } from "./screens/Incidents";
import { ConnectionsScreen } from "./screens/Connections";
import { ReaderScreen } from "./screens/Reader";
import { StoreProvider } from "./store";
import { PinProvider } from "./pin";
import { isStaffApp, showAdminUi } from "./flavor";

export function App() {
  const [auth, setAuth] = useState<AuthState | undefined>(undefined);
  const [bootError, setBootError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const next = await loadAuthState();
      setAuth(next);
      setBootError("");
    } catch (err) {
      setBootError(authErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    let unsub = () => {};
    void (async () => {
      await refresh();
      try {
        const { data } = floorCloud().auth.onAuthStateChange(() => {
          void refresh();
        });
        unsub = () => data.subscription.unsubscribe();
      } catch (err) {
        setBootError(authErrorMessage(err));
      }
    })();
    return () => unsub();
  }, [refresh]);

  if (auth === undefined) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-quiet text-floor-mute">
        <p>Floor</p>
        <Notice tone="error">{bootError}</Notice>
        {bootError ? (
          <button type="button" className="btn-accent mt-4" onClick={() => void refresh()}>
            Try again
          </button>
        ) : null}
      </div>
    );
  }

  if (auth.kind === "signed_out") {
    return (
      <Routes>
        <Route path="/login" element={<LoginScreen />} />
        {isStaffApp() ? null : <Route path="/signup" element={<SignupScreen />} />}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (auth.kind === "needs_store") {
    return <CreateStoreScreen email={auth.email} onReady={() => void refresh()} />;
  }

  return (
    <StoreProvider session={auth.session}>
      <PinProvider>
      <Shell>
        <Routes>
          <Route path="/inventory" element={<InventoryScreen />} />
          <Route path="/inventory/:sku" element={<UnitScreen />} />
          <Route path="/checkout/:sku" element={<CheckoutScreen />} />
          <Route path="/receive" element={<ReceiveScreen />} />
          <Route path="/sales" element={<SalesScreen />} />
          <Route path="/reader" element={<ReaderScreen />} />
          {showAdminUi(auth.session.role) ? (
            <>
              <Route path="/reports" element={<ReportsScreen />} />
              <Route path="/reports/:receiptNo" element={<ReportsScreen />} />
              <Route path="/delist" element={<DelistScreen />} />
              <Route path="/connections" element={<ConnectionsScreen />} />
              <Route path="/settings/categories" element={<CategoriesScreen />} />
              <Route path="/employees" element={<EmployeesScreen />} />
            </>
          ) : null}
          <Route path="/shipments" element={<ShipmentsScreen />} />
          <Route path="/incidents" element={<IncidentsScreen />} />
          {showAdminUi(auth.session.role) ? (
            <Route path="/settings" element={<SettingsScreen />} />
          ) : (
            <Route path="/settings" element={<Navigate to="/inventory" replace />} />
          )}
          {showAdminUi(auth.session.role) ? null : <Route path="/employees" element={<Navigate to="/inventory" replace />} />}
          <Route path="*" element={<Navigate to="/inventory" replace />} />
        </Routes>
      </Shell>
      </PinProvider>
    </StoreProvider>
  );
}
