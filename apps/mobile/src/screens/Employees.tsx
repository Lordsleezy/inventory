import { useCallback, useEffect, useState } from "react";
import { authHeader, functionsUrl } from "../functions";
import { useStore } from "../store";
import { DangerButton, Label, Notice, Spinner } from "../components/ui";

type Employee = {
  user_id: string;
  display_name: string;
  role: "owner" | "manager" | "staff";
  deactivated_at: string | null;
  created_at: string | null;
  email: string | null;
  last_sign_in_at: string | null;
};

type Created = { user_id: string; signInEmail: string; password: string };

async function call(action: string, body: Record<string, unknown> = {}) {
  const headers = await authHeader();
  const res = await fetch(functionsUrl("employees"), {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...body }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || `employees ${action} failed (HTTP ${res.status})`);
  }
  return payload;
}

export function EmployeesScreen() {
  const { session } = useStore();
  const owner = session.role === "owner";
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [name, setName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [role, setRole] = useState("staff");
  const [password, setPassword] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
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
    void load();
  }, [load]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError("");
    setOk("");
    try {
      await fn();
      setOk(done);
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
    setOk("");
    try {
      const payload = await call("create", {
        name: name.trim(),
        email: identifier.trim(),
        role,
        password: password.trim(),
      });
      setCreated({ user_id: payload.employee.user_id, signInEmail: payload.signInEmail, password: payload.password });
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

  const roleChoices = owner ? ["staff", "manager", "owner"] : ["staff", "manager"];

  return (
    <section>
      <h1 className="text-title">Employees</h1>
      <p className="mt-1 text-quiet text-floor-mute">
        Accounts work on the phone and the register. Deactivating or removing someone cuts access
        immediately.
      </p>
      <Notice tone="error">{error}</Notice>
      <Notice tone="ok">{ok}</Notice>

      <h2 className="mt-6 text-title">Add</h2>
      <label className="block py-2">
        <Label>Name</Label>
        <input className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block py-2">
        <Label>Email or username</Label>
        <input
          className="field mt-1"
          value={identifier}
          autoCapitalize="none"
          autoCorrect="off"
          inputMode="email"
          onChange={(e) => setIdentifier(e.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <label className="block flex-1 py-2">
          <Label>Role</Label>
          <select className="field mt-1" value={role} onChange={(e) => setRole(e.target.value)}>
            {roleChoices.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="block flex-1 py-2">
          <Label>Password (blank = generate)</Label>
          <input
            className="field mt-1"
            value={password}
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      </div>
      <button type="button" className="btn-accent mt-2" disabled={busy} onClick={() => void add()}>
        {busy ? "Working…" : "Create account"}
      </button>
      {created ? (
        <p className="mt-3 border border-floor-line p-3 text-body">
          Sign in: <span className="font-mono">{created.signInEmail}</span>
          <br />
          Password: <span className="font-mono">{created.password}</span>
          <span className="mt-1 block text-quiet text-floor-mute">
            Show this to them now — it is not stored anywhere you can see again.
          </span>
        </p>
      ) : null}

      <h2 className="mt-8 text-title">People</h2>
      {employees === null ? <Spinner label="Loading employees" /> : null}
      <ul className="mt-2">
        {employees?.map((emp) => {
          const self = emp.user_id === session.userId;
          const deactivated = Boolean(emp.deactivated_at);
          return (
            <li key={emp.user_id} className="border-b border-floor-line py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-body">
                    {emp.display_name}
                    {self ? " (you)" : ""}
                    {deactivated ? " — deactivated" : ""}
                  </span>
                  <span className="text-quiet text-floor-mute">
                    {emp.email || "—"} · {emp.role}
                  </span>
                </span>
              </div>
              {!self ? (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <select
                    className="field max-w-[9rem] py-1"
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
                  <button
                    type="button"
                    className="btn-text px-0"
                    disabled={busy}
                    onClick={() => {
                      setResetFor(resetFor === emp.user_id ? null : emp.user_id);
                      setResetPin("");
                    }}
                  >
                    Reset password
                  </button>
                  {deactivated ? (
                    <button
                      type="button"
                      className="btn-text px-0"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => call("setActive", { userId: emp.user_id, active: true }),
                          `${emp.display_name} reactivated`,
                        )
                      }
                    >
                      Reactivate
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-text px-0 text-floor-danger"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => call("setActive", { userId: emp.user_id, active: false }),
                          `${emp.display_name} deactivated — access cut`,
                        )
                      }
                    >
                      Deactivate
                    </button>
                  )}
                  <DangerButton
                    idle="Remove"
                    confirm="Remove permanently"
                    disabled={busy}
                    onError={(err) => setError(err instanceof Error ? err.message : String(err))}
                    onConfirm={() =>
                      run(
                        () => call("remove", { userId: emp.user_id }),
                        `${emp.display_name} removed`,
                      )
                    }
                  />
                </div>
              ) : null}
              {resetFor === emp.user_id ? (
                <div className="mt-2 flex items-end gap-2">
                  <label className="block flex-1">
                    <Label>New password / PIN</Label>
                    <input
                      className="field mt-1"
                      value={resetPin}
                      autoCapitalize="none"
                      autoCorrect="off"
                      onChange={(e) => setResetPin(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn-accent"
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
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
