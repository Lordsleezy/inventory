import { useState } from "react";
import { Link } from "react-router-dom";
import { floorCloud } from "@floor/cloud";
import { useStore } from "../store";
import { Label, Notice } from "../components/ui";
import { friendlyRpc } from "../rpc";
import { showAdminUi } from "../flavor";

export function SettingsScreen() {
  const { settings, setSetting, session, online, connectionType, supabaseReach, functionsReach } = useStore();
  const [error, setError] = useState("");
  const [pin, setPin] = useState("");
  const admin = showAdminUi(session.role);
  const owner = admin && session.role === "owner";

  async function signOut() {
    await floorCloud().auth.signOut();
    location.reload();
  }

  async function savePin() {
    setError("");
    const { error: rpcErr } = await floorCloud().rpc("set_manager_pin", { p_pin: pin });
    if (rpcErr) setError(friendlyRpc(rpcErr));
    else setPin("");
  }

  return (
    <section>
      <h1 className="text-title">Setup</h1>
      <Notice tone="error">{error}</Notice>
      <p className="mt-2 text-quiet text-floor-mute">
        Signed in as {session.displayName} ({session.role})
      </p>
      <p className="font-mono text-quiet">STORE_ID {session.storeId}</p>
      <p className="mt-2 font-mono text-quiet text-floor-mute">
        net {online ? "up" : "down"}/{connectionType} · supabase {supabaseReach} · functions {functionsReach}
      </p>
      <p className="text-quiet text-floor-mute">
        Import the phone backup against this STORE_ID after signup. Import refuses if this store already has units.
      </p>

      {admin ? (
        <>
          <Link to="/employees" className="btn-accent mt-4 inline-block">
            Employees
          </Link>
          <Link to="/settings/categories" className="btn-accent mt-4 ml-3 inline-block">
            Categories
          </Link>
        </>
      ) : null}

      <label className="mt-4 flex items-center gap-2">
        <input
          type="checkbox"
          checked={session.notifyEmail}
          onChange={(e) => void floorCloud().rpc("set_notify_prefs", { p_email: e.target.checked, p_push: session.notifyPush })}
        />
        <span className="text-body">Email alerts (Resend)</span>
      </label>
      <label className="mt-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={session.notifyPush}
          onChange={(e) => void floorCloud().rpc("set_notify_prefs", { p_email: session.notifyEmail, p_push: e.target.checked })}
        />
        <span className="text-body">Push alerts</span>
      </label>
      <p className="text-quiet text-floor-mute">Push not set up. Email still works today. Apple setup is later.</p>

      {admin ? (
        <>
          <label className="block py-3">
            <Label>Business name (receipts)</Label>
            <input
              className="field mt-1"
              defaultValue={settings.storeName}
              disabled={!online}
              onBlur={(e) => void setSetting("display_name", e.target.value.trim() || "Store")}
            />
          </label>
          <label className="block py-3">
            <Label>Sales tax percent</Label>
            <input
              className="field mt-1"
              defaultValue={(settings.taxRateBps / 100).toString()}
              inputMode="decimal"
              disabled={!online}
              onBlur={(e) => {
                const percent = Number(e.target.value);
                if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
                  setError("Tax percent should be a number between 0 and 100.");
                  return;
                }
                setError("");
                void setSetting("taxRateBps", Math.round(percent * 100));
              }}
            />
          </label>
        </>
      ) : (
        <p className="mt-4 text-quiet">Staff cannot change store settings.</p>
      )}

      {owner ? (
        <>
          <Link to="/connections" className="btn-accent mt-4 inline-block">
            Connections
          </Link>
          <label className="block py-3">
            <Label>Manager PIN (voids, below-floor, deletes)</Label>
            <input className="field mt-1" type="password" value={pin} onChange={(e) => setPin(e.target.value)} />
            <button type="button" className="btn-text px-0 mt-1" onClick={() => void savePin()}>
              Save PIN
            </button>
          </label>
        </>
      ) : null}

      <button type="button" className="btn-text px-0 mt-6" onClick={() => void signOut()}>
        Sign out
      </button>
    </section>
  );
}
