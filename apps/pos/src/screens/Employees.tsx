import { useCallback, useEffect, useState } from "react";
import { callFunction } from "../functions";
import { usePos } from "../pos-context";

type Employee = {
  user_id: string;
  display_name: string;
  role: "owner" | "manager" | "staff";
  deactivated_at: string | null;
  created_at: string | null;
  email: string | null;
  last_sign_in_at: string | null;
};

async function call(action: string, body: Record<string, unknown> = {}) {
  const res = await callFunction("employees", {
    method: "POST",
    body: JSON.stringify({ action, ...body }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `employees ${action} failed (HTTP ${res.status})`);
  return payload;
}

export function EmployeesScreen() {
  const { session, isAdmin } = usePos();
  const owner = session.role === "owner";
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [name, setName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [role, setRole] = useState("staff");
  const [password, setPassword] = useState("");
  const [created, setCreated] = useState<{ signInEmail: string; password: string } | null>(null);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPin, setResetPin] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const payload = await call("list");
      setEmployees(payload.employees as Employee[]);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      await fn();
      setMsg(done);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (!name.trim() || !identifier.trim()) {
      setError("Name and email/username are required.");
      return;
    }
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const payload = await call("create", {
        name: name.trim(),
        email: identifier.trim(),
        role,
        password: password.trim(),
      });
      setCreated({ signInEmail: payload.signInEmail, password: payload.password });
      setName("");
      setIdentifier("");
      setPassword("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!isAdmin) return <p className="page muted">Employees is for store admins.</p>;

  const roleChoices = owner ? ["staff", "manager", "owner"] : ["staff", "manager"];

  return (
    <section className="page grid">
      <h1>Employees</h1>
      <p className="muted">Accounts work on the register and the phone. Deactivate or remove cuts access immediately.</p>
      {error ? <p className="error">{error}</p> : null}
      {msg ? <p>{msg}</p> : null}

      <div className="card grid">
        <strong>Add employee</strong>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Email or username
          <input value={identifier} autoCapitalize="none" onChange={(e) => setIdentifier(e.target.value)} />
        </label>
        <div className="row">
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {roleChoices.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label>
            Password (blank = generate)
            <input value={password} autoCapitalize="none" onChange={(e) => setPassword(e.target.value)} />
          </label>
        </div>
        <button type="button" className="primary" disabled={busy} onClick={() => void add()}>
          {busy ? "Working…" : "Create account"}
        </button>
        {created ? (
          <p>
            Sign in: <strong>{created.signInEmail}</strong> · Password: <strong>{created.password}</strong>
            <span className="muted" style={{ display: "block" }}>
              Shown once — hand it to them now.
            </span>
          </p>
        ) : null}
      </div>

      <div className="card grid">
        <strong>People</strong>
        {!employees ? <p className="muted">Loading…</p> : null}
        {employees?.map((emp) => {
          const self = emp.user_id === session.userId;
          const deactivated = Boolean(emp.deactivated_at);
          return (
            <div key={emp.user_id} className="row" style={{ alignItems: "flex-start" }}>
              <span>
                {emp.display_name}
                {self ? " (you)" : ""}
                {deactivated ? " — deactivated" : ""}
                <div className="muted">
                  {emp.email || "—"} · {emp.role}
                </div>
              </span>
              {!self ? (
                <span className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                  <select
                    value={emp.role}
                    disabled={busy || (!owner && emp.role === "owner")}
                    onChange={(e) =>
                      void run(
                        () => call("setRole", { userId: emp.user_id, role: e.target.value }),
                        `${emp.display_name} is now ${e.target.value}`,
                      )
                    }
                  >
                    {roleChoices.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  {resetFor === emp.user_id ? (
                    <>
                      <input
                        value={resetPin}
                        placeholder="new password"
                        autoCapitalize="none"
                        onChange={(e) => setResetPin(e.target.value)}
                        style={{ width: "9rem" }}
                      />
                      <button
                        type="button"
                        disabled={busy || resetPin.length < 6}
                        onClick={() =>
                          void run(
                            () => call("resetPassword", { userId: emp.user_id, password: resetPin }),
                            `Password reset for ${emp.display_name}`,
                          ).then(() => setResetFor(null))
                        }
                      >
                        Save
                      </button>
                      <button type="button" onClick={() => setResetFor(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setResetFor(emp.user_id);
                        setResetPin("");
                      }}
                    >
                      Reset password
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => call("setActive", { userId: emp.user_id, active: deactivated }),
                        deactivated ? `${emp.display_name} reactivated` : `${emp.display_name} deactivated`,
                      )
                    }
                  >
                    {deactivated ? "Reactivate" : "Deactivate"}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`Remove ${emp.display_name} permanently?`)) return;
                      void run(
                        () => call("remove", { userId: emp.user_id }),
                        `${emp.display_name} removed`,
                      );
                    }}
                  >
                    Remove
                  </button>
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
