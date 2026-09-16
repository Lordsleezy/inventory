import { useState } from "react";
import { authErrorMessage, floorCloud } from "@floor/cloud";
import { AUTH_EMAIL_REDIRECT } from "../auth";
import { Label, Notice } from "../components/ui";

export function SignupScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [checkEmail, setCheckEmail] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      const { data, error: authError } = await floorCloud().auth.signUp({
        email,
        password,
        options: { emailRedirectTo: AUTH_EMAIL_REDIRECT },
      });
      if (authError) throw authError;
      if (!data.session) {
        setCheckEmail(true);
      }
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (checkEmail) {
    return (
      <section className="mx-auto max-w-md px-4 py-10">
        <h1 className="text-title">Check your email</h1>
        <p className="mt-2 text-quiet text-floor-mute">
          Confirm the link we sent to {email}, then sign in. After that you will create your store.
        </p>
        <p className="mt-4">
          <a href="#/login" className="btn-text px-0">
            Sign in
          </a>
        </p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-title">Create an account</h1>
      <p className="mt-1 text-quiet text-floor-mute">
        After you sign in, you will create the store. This is the only way a store is created.
      </p>
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
        {busy ? "Working…" : "Create account"}
      </button>
      <p className="mt-4">
        <a href="#/login" className="btn-text px-0">
          Already have an account
        </a>
      </p>
    </section>
  );
}
