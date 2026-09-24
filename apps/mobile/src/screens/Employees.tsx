import { useEffect, useState } from "react";
import { authHeader, functionsUrl } from "../functions";
import { Label, Notice } from "../components/ui";
import { useStore } from "../store";
import { showAdminUi } from "../flavor";

type Employee = {
  user_id: string;
  display_name: string;
  role: string;
  login_code: string | null;
  deactivated_at: string | null;
};

export function EmployeesScreen() {
  const { session } = useStore();
  const admin = showAdminUi(session.role);
  const [rows, setRows] = useState<Employee[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [name, setName] = useState("");
  const [clock, setClock] = useState("");
  const [pin, setPin] = useState("");
  const [role, setRole] = useState("staff");
  const [busy, setBusy] = useState(false);

  async function call(method: string, body?: unknown) {
    const headers = await authHeader();
    const res = await fetch(functionsUrl("staff-account"), {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Request failed");
    return json;
  }

  async function refresh() {
    const json = await call("GET");
    setRows(json.employees || []);
  }

  useEffect(() => {
    if (!admin) return;
    void refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [admin]);

  if (!admin) {
    return (
      <section>
        <h1 className="text-title">Employees</h1>
        <p className="mt-2 text-quiet">Only a manager can add logins.</p>
      </section>
    );
  }

  async function create() {
    setError("");
    setMsg("");
    setBusy(true);
    try {
      await call("POST", {
        action: "create",
        username: clock,
        pin,
        display_name: name,
        role,
      });
      setName("");
      setClock("");
      setPin("");
      setMsg("Login created. They sign in with that clock number and PIN on the register and the phone.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1 className="text-title">Employees</h1>
      <p className="mt-1 text-quiet text-floor-mute">
        Clock number + PIN. Same accounts on the iMac register and the phone. PIN is 4–8 digits, not the clock
        number, not 1111/0000, not 1234.
      </p>
      <Notice tone="error">{error}</Notice>
      {msg ? <p className="mt-2 text-quiet">{msg}</p> : null}

      <label className="block py-2">
        <Label>Name</Label>
        <input className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block py-2">
        <Label>Clock number</Label>
        <input className="field mt-1" inputMode="numeric" value={clock} onChange={(e) => setClock(e.target.value)} />
      </label>
      <label className="block py-2">
        <Label>PIN</Label>
        <input className="field mt-1" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
      </label>
      <label className="block py-2">
        <Label>Role</Label>
        <select className="field mt-1" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="staff">Staff</option>
          {session.role === "owner" ? <option value="manager">Manager</option> : null}
        </select>
      </label>
      <button type="button" className="btn-accent mt-2" disabled={busy} onClick={() => void create()}>
        {busy ? "Saving…" : "Create login"}
      </button>

      <ul className="mt-6 grid gap-3">
        {rows.map((row) => (
          <li key={row.user_id} className="border border-floor-line p-3">
            <p className="text-body">
              {row.display_name} · {row.role}
              {row.deactivated_at ? " · off" : ""}
            </p>
            <p className="text-quiet font-mono">{row.login_code || "email login"}</p>
            {row.role !== "owner" && row.user_id !== session.userId ? (
              <button
                type="button"
                className="btn-text px-0 mt-2"
                onClick={() =>
                  void call("POST", {
                    action: row.deactivated_at ? "enable" : "disable",
                    user_id: row.user_id,
                  })
                    .then(() => refresh())
                    .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                }
              >
                {row.deactivated_at ? "Enable" : "Disable"}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
