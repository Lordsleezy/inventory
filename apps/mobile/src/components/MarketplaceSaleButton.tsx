import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { authHeader, functionsUrl } from "../functions";

type Channel = { key: string; label: string; aliases?: string[] };

export function MarketplaceSaleButton({ sku, askCents, disabled, onDone }: { sku: string; askCents: number | null; disabled: boolean; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channel, setChannel] = useState("");
  const [price, setPrice] = useState(askCents == null ? "" : (askCents / 100).toFixed(2));
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const headers = await authHeader();
        const res = await fetch(functionsUrl("marketplace-sale"), { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ action: "channels" }) });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Could not load marketplace list.");
        if (!active) return;
        const rows = (body.channels || []) as Channel[];
        setChannels(rows);
        setChannel(rows.find(x => x.key === "mercari")?.key || rows[0]?.key || "");
      } catch (e) { if (active) setError(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { active = false; };
  }, []);

  async function sell(e: FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(price) * 100);
    if (!Number.isSafeInteger(cents) || cents <= 0) { setError("Enter a sale price greater than zero."); return; }
    const label = channels.find(x => x.key === channel)?.label || channel;
    if (!window.confirm(`Mark SKU ${sku} sold on ${label} for $${(cents / 100).toFixed(2)}?`)) return;
    setBusy(true); setError("");
    try {
      const headers = await authHeader();
      const res = await fetch(functionsUrl("marketplace-sale"), { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ sku, channel, price_cents: cents }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Sale failed (${res.status})`);
      setOpen(false); await onDone();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return <>
    <button type="button" className="btn-text mt-3 block" disabled={disabled || busy || !channels.length} onClick={() => setOpen(true)}>{busy ? "Recording sale…" : "Mark sold on marketplace…"}</button>
    {open && <div className="video-scan-modal" role="presentation"><form className="video-scan-modal-panel" onSubmit={sell}>
      <h2>Record marketplace sale · SKU {sku}</h2>
      {error && <p className="error" role="alert">{error}</p>}
      <label>Marketplace<select required value={channel} onChange={e => setChannel(e.target.value)}>{channels.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
      <label>Actual sale price ($)<input required inputMode="decimal" type="text" pattern="(?:[0-9]+(?:\.[0-9]{0,2})?|\.[0-9]{1,2})" value={price} onChange={e => { if (/^\d*(?:\.\d{0,2})?$/.test(e.target.value)) setPrice(e.target.value); }} /></label>
      <div className="actions"><button disabled={busy || !channel}>{busy ? "Saving…" : "Confirm sold"}</button><button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button></div>
    </form></div>}
    {error && !open && <p className="text-xs text-red-700">Marketplace list unavailable: {error}</p>}
  </>;
}
