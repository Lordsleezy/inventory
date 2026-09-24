import { useState } from "react";
import { authErrorMessage, floorCloud, loginEmailFromIdentifier, authSecretFromLogin } from "@floor/cloud";
import { Label, Notice } from "../components/ui";
import { isStaffApp } from "../flavor";

export function LoginScreen() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const staffApp = isStaffApp();

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
    <section className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-title">{staffApp ? "Floor staff" : "Floor"}</h1>
      <p className="mt-1 text-quiet text-floor-mute">Clock number and PIN, or email for an owner account.</p>
      <Notice tone="error">{error}</Notice>
      <label className="block py-2">
        <Label>Clock number or email</Label>
        <input
          className="field mt-1"
          value={identifier}
          autoCapitalize="none"
          inputMode="numeric"
          onChange={(e) => setIdentifier(e.target.value)}
        />
      </label>
      <label className="block py-2">
        <Label>PIN</Label>
        <input className="field mt-1" type="password" inputMode="numeric" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button type="button" className="btn-accent mt-4" disabled={busy} onClick={() => void submit()}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      {staffApp ? null : (
        <p className="mt-4 text-quiet">
          <a href="#/signup" className="btn-text px-0">
            Create a store
          </a>
        </p>
      )}
    </section>
  );
}
