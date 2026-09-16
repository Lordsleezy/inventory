import { useState } from "react";
import { authErrorMessage, floorCloud } from "@floor/cloud";
import { Label, Notice } from "../components/ui";

export function CreateStoreScreen({
  email,
  onReady,
}: {
  email: string;
  onReady: () => void;
}) {
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      const sb = floorCloud();
      if (invite.trim()) {
        const { error: invError } = await sb.rpc("accept_invite", {
          p_token: invite.trim(),
          p_display_name: name.trim() || email || "Staff",
        });
        if (invError) throw invError;
      } else {
        const { error: storeError } = await sb.rpc("signup_create_store", {
          p_display_name: name.trim() || "Store",
        });
        if (storeError) throw storeError;
      }
      onReady();
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setError("");
    try {
      const { error: outError } = await floorCloud().auth.signOut();
      if (outError) throw outError;
    } catch (err) {
      setError(authErrorMessage(err));
    }
  }

  return (
    <section className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-title">Create your store</h1>
      <p className="mt-1 text-quiet text-floor-mute">
        Signed in{email ? ` as ${email}` : ""}, but this account has no store yet.
      </p>
      <Notice tone="error">{error}</Notice>
      <label className="block py-2">
        <Label>Store / your name</Label>
        <input className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block py-2">
        <Label>Invite token (only if you were invited)</Label>
        <input className="field mt-1" value={invite} onChange={(e) => setInvite(e.target.value)} />
      </label>
      <button type="button" className="btn-accent mt-4" disabled={busy} onClick={() => void submit()}>
        {busy ? "Working…" : invite.trim() ? "Join store" : "Create store"}
      </button>
      <p className="mt-4">
        <button type="button" className="btn-text px-0" onClick={() => void signOut()}>
          Sign out
        </button>
      </p>
    </section>
  );
}
