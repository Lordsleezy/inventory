import { useState } from "react";
import { authErrorMessage, floorCloud, staffSignInAttempts } from "@floor/cloud";
import { Label, Notice } from "../components/ui";

export function LoginScreen() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
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
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-title">Floor</h1>
      <p className="mt-1 text-quiet text-floor-mute">Clock number and PIN, or email / username.</p>
      <Notice tone="error">{error}</Notice>
      <label className="block py-2">
        <Label>Clock number, username, or email</Label>
        <input className="field mt-1" value={identifier} autoCapitalize="none" onChange={(e) => setIdentifier(e.target.value)} />
      </label>
      <label className="block py-2">
        <Label>PIN or password</Label>
        <input className="field mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button type="button" className="btn-accent mt-4" disabled={busy} onClick={() => void submit()}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <p className="mt-4 text-quiet">
        <a href="#/signup" className="btn-text px-0">
          Create a store
        </a>
      </p>
    </section>
  );
}
