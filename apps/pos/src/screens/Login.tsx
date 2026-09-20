import { useState } from "react";
import { authErrorMessage, floorCloud } from "@floor/cloud";

export function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      const { error: authError } = await floorCloud().auth.signInWithPassword({ email, password });
      if (authError) throw authError;
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page" style={{ maxWidth: 420 }}>
      <h1>Floor</h1>
      <p className="muted">Sign in with your staff email. This register does not receive inventory.</p>
      {error ? <p className="error">{error}</p> : null}
      <div className="grid">
        <label>
          Email
          <input value={email} autoCapitalize="none" onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </section>
  );
}
