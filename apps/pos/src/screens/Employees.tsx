import { useEffect, useState } from "react";
import { callFunction } from "../functions";
import { usePos } from "../pos-context";

type Employee = {
  user_id: string;
  display_name: string;
  role: string;
  login_code: string | null;
  deactivated_at: string | null;
};

export function EmployeesScreen() {
  const { isAdmin, session } = usePos();
  const [rows, setRows] = useState<Employee[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [name, setName] = useState("");
  const [clock, setClock] = useState("");
  const [pin, setPin] = useState("");
  const [role, setRole] = useState("staff");
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await callFunction("staff-account", { method: "GET" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Could not load employees");
    setRows(json.employees || []);
  }

  useEffect(() => {
    if (!isAdmin) return;
    void load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <section className="page">
        <h1>Employees</h1>
        <p className="muted">Ask a manager to add logins.</p>
      </section>
    );
  }

  async function create() {
    setError("");
    setMsg("");
    setBusy(true);
    try {
      const res = await callFunction("staff-account", {
        method: "POST",
        body: JSON.stringify({
          action: "create",
          username: clock,
          pin,
          display_name: name,
          role,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Create failed");
      setName("");
      setClock("");
      setPin("");
      setMsg("Login created. Same clock number and PIN work on this register and the phone.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page grid">
      <h1>Employees</h1>
      <p className="muted">
        Creating a login writes a real sign-in (clock number + PIN). That is what the login screen checks — not a
        local list. PIN: 4–8 digits, not the clock number, not all one digit, not 1234.
      </p>
      {error ? <p className="error">{error}</p> : null}
      {msg ? <p>{msg}</p> : null}
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Clock number
        <input inputMode="numeric" value={clock} onChange={(e) => setClock(e.target.value)} />
      </label>
      <label>
        PIN
        <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
      </label>
      <label>
        Role
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="staff">Staff</option>
          {session.role === "owner" ? <option value="manager">Manager</option> : null}
        </select>
      </label>
      <button type="button" className="primary" disabled={busy} onClick={() => void create()}>
        {busy ? "Saving…" : "Create login"}
      </button>
      {rows.map((row) => (
        <div key={row.user_id} className="card">
          <strong>
            {row.display_name} · {row.role}
            {row.deactivated_at ? " · off" : ""}
          </strong>
          <p className="muted">{row.login_code || "email login"}</p>
        </div>
      ))}
    </section>
  );
}
