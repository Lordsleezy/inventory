import { useState } from "react";
import { floorCloud } from "@floor/cloud";
import { useStore } from "../store";
import { Label, Notice } from "../components/ui";
import { friendlyRpc } from "../rpc";

export function SettingsScreen() {
  const { session } = useStore();
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function signOut() {
    await floorCloud().auth.signOut();
    location.reload();
  }

  async function changePassword() {
    setError("");
    setOk("");
    if (password.length < 6) {
      setError("Password needs at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    const { error: updateErr } = await floorCloud().auth.updateUser({ password });
    setBusy(false);
    if (updateErr) {
      setError(friendlyRpc(updateErr));
      return;
    }
    setPassword("");
    setConfirm("");
    setOk("Password changed.");
  }

  return (
    <section>
      <h1 className="text-title">Settings</h1>
      <Notice tone="error">{error}</Notice>
      <Notice tone="ok">{ok}</Notice>
      <p className="mt-2 text-quiet text-floor-mute">
        Signed in as {session.displayName} ({session.role})
      </p>

      <h2 className="mt-6 text-title">Alerts</h2>
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

      <h2 className="mt-8 text-title">Change password</h2>
      <label className="block py-2">
        <Label>New password</Label>
        <input
          className="field mt-1"
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label className="block py-2">
        <Label>Repeat new password</Label>
        <input
          className="field mt-1"
          type="password"
          value={confirm}
          autoComplete="new-password"
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>
      <button type="button" className="btn-accent mt-2" disabled={busy} onClick={() => void changePassword()}>
        {busy ? "Saving…" : "Change password"}
      </button>

      <button type="button" className="btn-text px-0 mt-8" onClick={() => void signOut()}>
        Sign out
      </button>
    </section>
  );
}
