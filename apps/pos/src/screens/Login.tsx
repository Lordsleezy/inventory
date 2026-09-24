import { useState } from "react";
import { authErrorMessage, floorCloud, isNetworkAuthFailure, staffSignInAttempts } from "@floor/cloud";

export function LoginScreen() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [networkHint, setNetworkHint] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    setNetworkHint(false);
    setBusy(true);
    try {
      const attempts = staffSignInAttempts(identifier, password);
      if (!attempts.length) throw new Error("Enter a valid email, username, or clock number.");
      let last: unknown = new Error("Could not sign in.");
      for (const attempt of attempts) {
        const { error: authError } = await floorCloud().auth.signInWithPassword(attempt);
        if (!authError) return;
        last = authError;
      }
      throw last;
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
      <p className="muted">Clock number and PIN — same logins as the phone.</p>
      {error ? <p className="error">{error}</p> : null}
      {networkHint ? (
        <p className="muted">If Wi‑Fi looks fine, open a browser on this Mac and load the Supabase host, then try again.</p>
      ) : null}
      <div className="grid" style={{ marginTop: "1rem" }}>
        <label>
          Clock number, username, or email
          <input value={identifier} autoCapitalize="none" onChange={(e) => setIdentifier(e.target.value)} />
        </label>
        <label>
          PIN or password
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
