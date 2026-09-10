import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { getApiUrl, getToken, loadBundledConfig } from "./api";
import { InventoryScreen } from "./screens/Inventory";
import { LoginScreen } from "./screens/Login";
import { ReportsScreen } from "./screens/Reports";
import { SetupScreen } from "./screens/Setup";
import { UnitScreen } from "./screens/Unit";

function Gate({
  needApi,
  needAuth,
  children,
}: {
  needApi?: boolean;
  needAuth?: boolean;
  children: React.ReactNode;
}) {
  if (needApi && !getApiUrl()) return <Navigate to="/setup" replace />;
  if (needAuth && !getToken()) return <Navigate to="/login" replace />;
  return children;
}

export function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void loadBundledConfig().finally(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md items-center justify-center bg-floor-bg text-quiet text-floor-mute">
        Floor
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/setup" element={<SetupScreen />} />
      <Route
        path="/login"
        element={
          <Gate needApi>
            <LoginScreen />
          </Gate>
        }
      />
      <Route
        path="/inventory"
        element={
          <Gate needApi needAuth>
            <InventoryScreen />
          </Gate>
        }
      />
      <Route
        path="/inventory/:sku"
        element={
          <Gate needApi needAuth>
            <UnitScreen />
          </Gate>
        }
      />
      <Route
        path="/reports"
        element={
          <Gate needApi needAuth>
            <ReportsScreen />
          </Gate>
        }
      />
      <Route path="*" element={<Navigate to={getApiUrl() ? (getToken() ? "/inventory" : "/login") : "/setup"} replace />} />
    </Routes>
  );
}
