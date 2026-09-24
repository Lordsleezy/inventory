import { useState } from "react";
import { authErrorMessage, floorCloud, loginEmailFromIdentifier, authSecretFromLogin } from "@floor/cloud";

export function LoginScreen() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      const email = loginEmailFromIdentifier(identifier);
      const { error: authError } = await floorCloud().auth.signInWithPassword({
        email,
        password: authSecretFromLogin(identifier, password),
      });
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
      <p className="muted">Clock number and PIN — same logins as the phone. This register does not receive inventory.</p>
      {error ? <p className="error">{error}</p> : null}
      <div className="grid">
        <label>
          Clock number or email
          <input value={identifier} autoCapitalize="none" inputMode="numeric" onChange={(e) => setIdentifier(e.target.value)} />
        </label>
        <label>
          PIN
          <input type="password" inputMode="numeric" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </section>
  );
}
