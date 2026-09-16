import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { loadStaffSession, type StaffSession } from "@floor/cloud";
import { Shell } from "./components/Shell";
import { InventoryScreen } from "./screens/Inventory";
import { ReceiveScreen } from "./screens/Receive";
import { ReportsScreen } from "./screens/Reports";
import { SalesScreen } from "./screens/Sales";
import { SettingsScreen } from "./screens/Settings";
import { UnitScreen } from "./screens/Unit";
import { LoginScreen } from "./screens/Login";
import { SignupScreen } from "./screens/Signup";
import { CheckoutScreen } from "./screens/Checkout";
import { DelistScreen } from "./screens/Delist";
import { IncidentsScreen } from "./screens/Incidents";
import { ConnectionsScreen } from "./screens/Connections";
import { StoreProvider } from "./store";

export function App() {
  const [session, setSession] = useState<StaffSession | null | undefined>(undefined);

  useEffect(() => {
    void loadStaffSession()
      .then(setSession)
      .catch(() => setSession(null));
  }, []);

  if (session === undefined) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md items-center justify-center text-quiet text-floor-mute">
        Floor
      </div>
    );
  }

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<LoginScreen />} />
        <Route path="/signup" element={<SignupScreen />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <StoreProvider session={session}>
      <Shell>
        <Routes>
          <Route path="/inventory" element={<InventoryScreen />} />
          <Route path="/inventory/:sku" element={<UnitScreen />} />
          <Route path="/checkout/:sku" element={<CheckoutScreen />} />
          <Route path="/receive" element={<ReceiveScreen />} />
          <Route path="/sales" element={<SalesScreen />} />
          <Route path="/reports" element={<ReportsScreen />} />
          <Route path="/delist" element={<DelistScreen />} />
          <Route path="/incidents" element={<IncidentsScreen />} />
          <Route path="/connections" element={<ConnectionsScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="*" element={<Navigate to="/inventory" replace />} />
        </Routes>
      </Shell>
    </StoreProvider>
  );
}
