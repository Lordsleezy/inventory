import { useState } from "react";
import { floorCloud } from "@floor/cloud";
import { Label, Notice } from "../components/ui";

export function SignupScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      const { error: authError } = await floorCloud().auth.signUp({ email, password });
      if (authError) throw authError;
      const { error: signInError } = await floorCloud().auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;
      if (invite.trim()) {
        const { error: invError } = await floorCloud().rpc("accept_invite", {
          p_token: invite.trim(),
          p_display_name: name.trim() || email,
        });
        if (invError) throw invError;
      } else {
        const { error: storeError } = await floorCloud().rpc("signup_create_store", {
          p_display_name: name.trim() || "Store",
        });
        if (storeError) throw storeError;
      }
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
      <h1 className="text-title">Create your store</h1>
      <p className="mt-1 text-quiet text-floor-mute">
        This is the only way a store is created. After this, import your phone backup with the STORE_ID shown in Setup.
      </p>
      <Notice tone="error">{error}</Notice>
      <label className="block py-2">
        <Label>Store / your name</Label>
        <input className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block py-2">
        <Label>Email</Label>
        <input className="field mt-1" value={email} autoCapitalize="none" onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="block py-2">
        <Label>Password</Label>
        <input className="field mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label className="block py-2">
        <Label>Invite token (only if you were invited)</Label>
        <input className="field mt-1" value={invite} onChange={(e) => setInvite(e.target.value)} />
      </label>
      <button type="button" className="btn-accent mt-4" disabled={busy} onClick={() => void submit()}>
        {busy ? "Working…" : invite.trim() ? "Join store" : "Create store"}
      </button>
      <p className="mt-4">
        <a href="#/login" className="btn-text px-0">
          Already have an account
        </a>
      </p>
    </section>
  );
}
