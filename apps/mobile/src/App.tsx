import { Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell";
import { BackupScreen } from "./screens/Backup";
import { InventoryScreen } from "./screens/Inventory";
import { ReceiveScreen } from "./screens/Receive";
import { ReportsScreen } from "./screens/Reports";
import { SalesScreen } from "./screens/Sales";
import { SettingsScreen } from "./screens/Settings";
import { UnitScreen } from "./screens/Unit";
import { StoreProvider } from "./store";

export function App() {
  return (
    <StoreProvider>
      <Shell>
        <Routes>
          <Route path="/inventory" element={<InventoryScreen />} />
          <Route path="/inventory/:sku" element={<UnitScreen />} />
          <Route path="/receive" element={<ReceiveScreen />} />
          <Route path="/sales" element={<SalesScreen />} />
          <Route path="/reports" element={<ReportsScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="/backup" element={<BackupScreen />} />
          <Route path="*" element={<Navigate to="/inventory" replace />} />
        </Routes>
      </Shell>
    </StoreProvider>
  );
}
