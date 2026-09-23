import { useState } from "react";
import { floorCloud } from "@floor/cloud";
import { usePos } from "../pos-context";

export function AccountScreen() {
  const { session } = usePos();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function changePassword() {
    setError("");
    setMsg("");
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
      setError(updateErr.message);
      return;
    }
    setPassword("");
    setConfirm("");
    setMsg("Password changed.");
  }

  return (
    <section className="page grid" style={{ maxWidth: 480 }}>
      <h1>Settings</h1>
      <p className="muted">
        Signed in as {session.displayName} ({session.role})
      </p>
      {error ? <p className="error">{error}</p> : null}
      {msg ? <p>{msg}</p> : null}

      <div className="card grid">
        <strong>Change password</strong>
        <label>
          New password
          <input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          Repeat new password
          <input
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <button type="button" className="primary" disabled={busy} onClick={() => void changePassword()}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </div>
    </section>
  );
}
