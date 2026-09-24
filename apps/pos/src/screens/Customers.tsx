import { useCallback, useEffect, useState } from "react";
import {
  adjustCustomerPoints,
  authErrorMessage,
  listCustomers,
  queueLoyaltyCampaign,
  type CustomerListRow,
} from "@floor/cloud";
import { formatCentsTotal } from "@floor/store";
import { callFunction } from "../functions";
import { usePos } from "../pos-context";

function money(cents: number): string {
  return formatCentsTotal(cents);
}

export function CustomersScreen() {
  const { isAdmin } = usePos();
  const [rows, setRows] = useState<CustomerListRow[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<CustomerListRow | null>(null);
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [minSpend, setMinSpend] = useState("");
  const [days, setDays] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await listCustomers(q.trim() || null, 300);
      setRows(data);
      setError("");
    } catch (err) {
      setError(authErrorMessage(err));
    }
  }, [q]);

  useEffect(() => {
    if (!isAdmin) return;
    void load();
  }, [isAdmin, load]);

  async function onAdjust() {
    if (!selected) return;
    const n = Number(delta);
    if (!Number.isFinite(n) || n === 0) {
      setError("Enter a positive or negative point amount.");
      return;
    }
    setBusy(true);
    setError("");
    setMsg("");
    try {
      await adjustCustomerPoints({ customerId: selected.id, delta: Math.round(n * 10) / 10, note });
      setMsg("Balance updated.");
      setDelta("");
      await load();
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCampaign() {
    if (!subject.trim() || !body.trim()) {
      setError("Subject and body are required.");
      return;
    }
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const queued = await queueLoyaltyCampaign({
        subject: subject.trim(),
        body: body.trim(),
        minSpendCents: Math.round((Number(minSpend) || 0) * 100),
        days: days.trim() ? Number(days) : null,
      });
      await callFunction("loyalty-email", { method: "POST", body: JSON.stringify({ action: "drain" }) }).catch(
        () => {},
      );
      setMsg(`Queued ${queued.queued} email${queued.queued === 1 ? "" : "s"}. Sending in the background.`);
      setSubject("");
      setBody("");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!isAdmin) return <p className="page">Admin only.</p>;

  return (
    <section className="page grid">
      <h1>Customers</h1>
      <p className="muted">
        Phone lookup at the register is for everyone. This list, totals, and balance edits are admin only.
        Email is for store news — we do not text.
      </p>
      {error ? <p className="error">{error}</p> : null}
      {msg ? <p>{msg}</p> : null}

      <div className="row">
        <input
          placeholder="Search phone, name, email"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="button" onClick={() => void load()}>
          Search
        </button>
      </div>

      <div className="card" style={{ overflow: "auto" }}>
        <table className="cart-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Email</th>
              <th>Points</th>
              <th>Credit</th>
              <th>Spend</th>
              <th>Last visit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => setSelected(r)}
                style={{ cursor: "pointer", background: selected?.id === r.id ? "var(--bg-2, #eee)" : undefined }}
              >
                <td>{r.name || "—"}</td>
                <td>{r.phone}</td>
                <td>
                  {r.email || "—"}
                  {r.unsubscribed ? " (unsub)" : r.marketing_opt_in ? "" : " (no email ads)"}
                </td>
                <td>{r.points}</td>
                <td>{money(r.credit_cents)}</td>
                <td>{money(r.spend_cents)}</td>
                <td>{r.last_visit ? new Date(r.last_visit).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={7}>
                  <p className="muted">No customers yet.</p>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="card grid">
        <strong>Adjust points {selected ? `· ${selected.name || selected.phone}` : ""}</strong>
        <p className="muted">Every $100 spent = 10 points. Every 100 points = $10 off. Positive adjustments add points.</p>
        <label>
          Points (+/−)
          <input value={delta} onChange={(e) => setDelta(e.target.value)} inputMode="decimal" step="0.1" disabled={!selected} />
        </label>
        <label>
          Note
          <input value={note} onChange={(e) => setNote(e.target.value)} disabled={!selected} />
        </label>
        <button type="button" className="primary" disabled={busy || !selected} onClick={() => void onAdjust()}>
          Apply adjustment
        </button>
      </div>

      <div className="card grid">
        <strong>Email customers</strong>
        <p className="muted">
          Sends only to people who opted in for email and have not unsubscribed. Never texts.
        </p>
        <label>
          Subject
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label>
          Body
          <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <label>
          Min spend ($) — leave blank for everyone opted in
          <input value={minSpend} onChange={(e) => setMinSpend(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Purchased in last N days — blank = any time
          <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" />
        </label>
        <button type="button" className="primary" disabled={busy} onClick={() => void onCampaign()}>
          Send
        </button>
      </div>
    </section>
  );
}
