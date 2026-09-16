import { useState } from "react";
import { floorCloud } from "@floor/cloud";
import { Label, Notice } from "../components/ui";

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
      location.hash = "#/";
      location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-title">Floor</h1>
      <p className="mt-1 text-quiet text-floor-mute">Sign in with your staff email.</p>
      <Notice tone="error">{error}</Notice>
      <label className="block py-2">
        <Label>Email</Label>
        <input className="field mt-1" value={email} autoCapitalize="none" onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="block py-2">
        <Label>Password</Label>
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
