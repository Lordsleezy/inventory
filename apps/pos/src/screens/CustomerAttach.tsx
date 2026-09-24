import { useEffect, useRef, useState } from "react";
import { formatCentsTotal } from "@floor/store";
import {
  authErrorMessage,
  loadCustomerProfile,
  searchCustomersByPhone,
  upsertCustomer,
  type Customer,
  type CustomerProfile,
} from "@floor/cloud";
import { callFunction } from "../functions";

function formatPoints(points: number): string {
  return Number((Number(points) || 0).toFixed(1)).toString();
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case "earn_sale":
      return "Earned";
    case "redeem_sale":
      return "Redeemed";
    case "void_reverse_earn":
      return "Void − reverse earn";
    case "void_restore_redeem":
      return "Void − restore redeem";
    case "adjust":
      return "Manual adjust";
    case "signup":
      return "Signup";
    default:
      return reason;
  }
}

type Props = {
  customer: Customer | null;
  onAttach: (customer: Customer) => void;
  onClear: () => void;
  disabled?: boolean;
};

export function CustomerAttach({ customer, onAttach, onClear, disabled }: Props) {
  const [phone, setPhone] = useState("");
  const [hits, setHits] = useState<Customer[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signupOpen, setSignupOpen] = useState(false);
  const [signupName, setSignupName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupMarketing, setSignupMarketing] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const digits = phone.replace(/\D/g, "");

  useEffect(() => {
    if (customer) {
      setPhone(customer.phone);
      setHits([]);
      setOpen(false);
    }
  }, [customer?.id, customer?.phone]);

  useEffect(() => {
    if (customer || digits.length < 3) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      void searchCustomersByPhone(digits, 8)
        .then((rows) => {
          setHits(rows);
          setOpen(true);
          setError("");
        })
        .catch((err) => setError(authErrorMessage(err)));
    }, 120);
    return () => clearTimeout(t);
  }, [digits, customer]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function pick(row: Customer) {
    onAttach(row);
    setPhone(row.phone);
    setOpen(false);
    setHits([]);
  }

  function startCreate() {
    setSignupOpen(true);
    setSignupName("");
    setSignupEmail("");
    setSignupMarketing(false);
    setOpen(false);
  }

  async function createCustomer() {
    setError("");
    const name = signupName.trim();
    const email = signupEmail.trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    if (!email.includes("@")) {
      setError("Email is required.");
      return;
    }
    if (digits.length < 7) {
      setError("Enter a full phone number.");
      return;
    }
    setBusy(true);
    try {
      const created = await upsertCustomer({
        phone: digits,
        name,
        email,
        marketingOptIn: signupMarketing,
      });
      onAttach(created);
      setPhone(created.phone);
      setSignupOpen(false);
      void callFunction("loyalty-email", {
        method: "POST",
        body: JSON.stringify({ action: "drain" }),
      }).catch(() => {});
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function openProfile() {
    if (!customer) return;
    setProfileOpen(true);
    setProfileBusy(true);
    setError("");
    try {
      setProfile(await loadCustomerProfile(customer.id));
    } catch (err) {
      setError(authErrorMessage(err));
      setProfile(null);
    } finally {
      setProfileBusy(false);
    }
  }

  function clearCustomer() {
    onClear();
    setPhone("");
    setHits([]);
    setOpen(false);
    setProfileOpen(false);
    setProfile(null);
  }

  const showCreate = !customer && digits.length >= 3 && hits.length === 0 && open;

  return (
    <>
      {customer ? (
        <button type="button" className="register-customer-chip" onClick={() => void openProfile()} disabled={disabled}>
          <span className="register-customer-chip-name">{customer.name || "Customer"}</span>
          <span className="muted">{formatPoints(customer.balance)} pts</span>
        </button>
      ) : null}

      <div className="customer-block" ref={wrapRef}>
        <strong>Customer</strong>
        <div className="customer-typeahead">
          <input
            placeholder="Phone number"
            value={phone}
            disabled={disabled || Boolean(customer)}
            onChange={(e) => {
              setPhone(e.target.value);
              if (customer) onClear();
            }}
            onFocus={() => {
              if (!customer && digits.length >= 3) setOpen(true);
            }}
            inputMode="tel"
            autoComplete="off"
          />
          {customer ? (
            <button type="button" className="ghost" disabled={disabled} onClick={clearCustomer}>
              Clear
            </button>
          ) : null}
          {open && !customer && digits.length >= 3 ? (
            <div className="customer-dropdown" role="listbox">
              {hits.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="customer-dropdown-hit"
                  onClick={() => pick(row)}
                >
                  <strong>{row.name || "No name"}</strong>
                  <span className="muted">
                    {row.phone}
                    {row.email ? ` · ${row.email}` : ""}
                    {` · ${formatPoints(row.balance)} pts`}
                  </span>
                </button>
              ))}
              {showCreate ? (
                <button type="button" className="customer-dropdown-hit create" onClick={startCreate}>
                  <strong>Create account</strong>
                  <span className="muted">No match for {digits} — name, phone, email</span>
                </button>
              ) : null}
              {!showCreate && hits.length === 0 ? (
                <div className="customer-dropdown-empty muted">Searching…</div>
              ) : null}
            </div>
          ) : null}
        </div>
        {customer ? (
          <p className="muted" style={{ margin: 0 }}>
            Attached · tap name (top right) for profile
            {!customer.first_purchase_discount_used
              ? ` · 5% new (${customer.signup_code || "on account"})`
              : ""}
          </p>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Type at least 3 digits — matches appear as you type.
          </p>
        )}
        {error ? <p className="error">{error}</p> : null}
      </div>

      {signupOpen ? (
        <div className="modal">
          <div className="card grid">
            <h2>New customer</h2>
            <p className="muted">Phone {digits}. Same account on the website.</p>
            <label>
              Name
              <input value={signupName} onChange={(e) => setSignupName(e.target.value)} autoFocus />
            </label>
            <label>
              Email
              <input value={signupEmail} onChange={(e) => setSignupEmail(e.target.value)} />
            </label>
            <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={signupMarketing}
                onChange={(e) => setSignupMarketing(e.target.checked)}
              />
              Email store news (optional)
            </label>
            {error ? <p className="error">{error}</p> : null}
            <div className="row">
              <button type="button" onClick={() => setSignupOpen(false)}>
                Cancel
              </button>
              <button type="button" className="primary" disabled={busy} onClick={() => void createCustomer()}>
                {busy ? "Saving…" : "Create & attach"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {profileOpen && customer ? (
        <div className="modal">
          <div className="card grid customer-profile-modal">
            <div className="row">
              <h2 style={{ margin: 0 }}>{customer.name || "Customer"}</h2>
              <button type="button" className="ghost" onClick={() => setProfileOpen(false)}>
                Close
              </button>
            </div>
            {profileBusy ? <p className="muted">Loading profile…</p> : null}
            {profile ? (
              <>
                <div className="customer-profile-meta">
                  <div>
                    <span className="muted">Phone</span>
                    <div>{profile.customer.phone}</div>
                  </div>
                  <div>
                    <span className="muted">Email</span>
                    <div>{profile.customer.email || "—"}</div>
                  </div>
                  <div>
                    <span className="muted">Points / credit</span>
                    <div>
                      {formatPoints(profile.customer.balance)} pts ·{" "}
                      {formatCentsTotal(profile.customer.credit_cents ?? 0)}
                    </div>
                  </div>
                  <div>
                    <span className="muted">5% new-customer code</span>
                    <div>
                      {profile.customer.signup_code || "—"}
                      {profile.customer.first_purchase_discount_used ? " · used" : " · available"}
                    </div>
                  </div>
                </div>

                <h3>Purchases</h3>
                {profile.purchases.length === 0 ? (
                  <p className="muted">No in-store or website purchases yet.</p>
                ) : (
                  <div className="customer-history-list">
                    {profile.purchases.map((p) => (
                      <div key={p.ticket_id} className={`customer-history-ticket${p.voided ? " voided" : ""}`}>
                        <div className="row">
                          <strong>
                            {new Date(p.sold_at).toLocaleString()} · {p.channel}
                            {p.voided ? " · VOID" : ""}
                          </strong>
                          <strong>{formatCentsTotal(p.total_cents)}</strong>
                        </div>
                        <div className="muted">
                          {p.payment_method || "—"}
                          {p.discount_cents ? ` · discount ${formatCentsTotal(p.discount_cents)}` : ""}
                          {p.signup_discount_cents
                            ? ` · signup ${formatCentsTotal(p.signup_discount_cents)}`
                            : ""}
                          {p.points_earned ? ` · +${formatPoints(p.points_earned)} pts` : ""}
                          {p.points_redeemed ? ` · −${formatPoints(p.points_redeemed)} pts` : ""}
                        </div>
                        <ul>
                          {p.lines.map((line, i) => (
                            <li key={`${p.ticket_id}-${line.sku}-${i}`}>
                              {line.qty > 1 ? `${line.qty}× ` : ""}
                              {line.title} ({line.sku}) — {formatCentsTotal(line.price_cents)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}

                <h3>Points activity</h3>
                {profile.points.length === 0 ? (
                  <p className="muted">No points activity yet.</p>
                ) : (
                  <div className="customer-history-list">
                    {profile.points.map((row) => (
                      <div key={row.id} className="row customer-points-row">
                        <span>
                          {new Date(row.created_at).toLocaleString()} · {reasonLabel(row.reason)}
                        </span>
                        <span>
                          {row.delta > 0 ? "+" : ""}
                          {formatPoints(row.delta)} → {formatPoints(row.balance_after)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : null}
            <div className="row">
              <button type="button" className="danger" onClick={clearCustomer}>
                Remove from this sale
              </button>
              <button type="button" onClick={() => setProfileOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
