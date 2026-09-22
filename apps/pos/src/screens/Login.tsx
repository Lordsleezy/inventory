import { useState } from "react";
import { authErrorMessage, floorCloud, isNetworkAuthFailure } from "@floor/cloud";

export function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [networkHint, setNetworkHint] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    setNetworkHint(false);
    setBusy(true);
    try {
      const { error: authError } = await floorCloud().auth.signInWithPassword({ email, password });
      if (authError) throw authError;
    } catch (err) {
      setError(authErrorMessage(err));
      setNetworkHint(isNetworkAuthFailure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="login-card">
      <h1>Floor</h1>
      <p className="muted">Sign in with your staff email. This register does not receive inventory.</p>
      {error ? <p className="error">{error}</p> : null}
      {networkHint ? (
        <p className="muted">If Wi‑Fi looks fine, open a browser on this Mac and load the Supabase host, then try again.</p>
      ) : null}
      <div className="grid" style={{ marginTop: "1rem" }}>
        <label>
          Email
          <input value={email} autoCapitalize="none" onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </label>
        <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </section>
  );
}
