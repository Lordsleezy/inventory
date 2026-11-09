import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';
import { LabelPaperSetting } from './LabelPaperSetting';
import { PROTECTED_ADMIN_EMAIL, peopleForCommission } from './settingsPeople';

type Person = { user_id: string; display_name: string; kind: string };
type Method = 'percent_sale' | 'flat_ticket' | 'percent_profit';
type Rule = { employee_id: string; method: Method; rate: number };
type Employee = {
  user_id: string;
  display_name: string;
  role: string;
  email: string | null;
  deactivated_at: string | null;
};

type Props = {
  accessToken: string;
  busy: boolean;
  run: (f: () => Promise<void>) => Promise<void>;
  staff: Person[];
  rules: Rule[];
  saveRule: (id: string, method: Method, rate: number) => Promise<void>;
  reloadPeople: () => Promise<void>;
  client?: SupabaseClient;
};

const PERCENTS = Array.from({ length: 100 }, (_, i) => i + 1);

async function employeesCall(token: string, action: string, body: Record<string, unknown> = {}) {
  const res = await fetch(floorFunctionUrl('employees'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `Could not ${action} the user`);
  return payload as { employees?: Employee[]; employee?: { user_id: string }; error?: string };
}

function permissionLabel(role: string) {
  return role === 'staff' ? 'Staff' : 'Admin';
}

export function SettingsPage({ accessToken, busy, run, staff, rules, saveRule, reloadPeople, client }: Props) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [permission, setPermission] = useState<'staff' | 'admin'>('staff');
  const [commission, setCommission] = useState('0');
  const [method, setMethod] = useState<Method>('percent_profit');

  const loadUsers = useCallback(async () => {
    const payload = await employeesCall(accessToken, 'list');
    setEmployees((payload.employees || []).filter((row) => !row.deactivated_at));
  }, [accessToken]);

  useEffect(() => { void loadUsers().catch((err) => setError(err instanceof Error ? err.message : String(err))); }, [loadUsers]);

  const emailById = new Map(employees.map((row) => [row.user_id, row.email]));
  const commissionPeople = peopleForCommission(staff, rules, emailById);

  async function addPerson(event: FormEvent) {
    event.preventDefault();
    setError('');
    await run(async () => {
      const payload = await employeesCall(accessToken, 'create', {
        name: name.trim(),
        username: username.trim(),
        password,
        role: permission,
      });
      const userId = payload.employee?.user_id;
      const pct = Number(commission);
      if (userId && pct > 0) await saveRule(userId, method, pct);
      setName(''); setUsername(''); setPassword(''); setPermission('staff'); setCommission('0'); setAdding(false);
      await reloadPeople();
      await loadUsers();
    });
  }

  async function removeUser(row: Employee) {
    if ((row.email || '').toLowerCase() === PROTECTED_ADMIN_EMAIL) return;
    if (!window.confirm(`Remove ${row.display_name}? They will lose their login.`)) return;
    setError('');
    await run(async () => {
      await employeesCall(accessToken, 'remove', { userId: row.user_id });
      await reloadPeople();
      await loadUsers();
    });
  }

  return <>
    <header><div><div className="eyebrow">CONFIGURATION</div><h1>Settings</h1>
      <p>Commission split and who can sign in.</p></div></header>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="panel">
      <h2>Commission split</h2>
      <p className="hint">A percent puts the person on the payouts screen. User only keeps the login and leaves them off payouts.</p>
      {commissionPeople.map((person) => {
        const rule = rules.find((row) => row.employee_id === person.user_id);
        return <CommissionRow key={person.user_id} person={person} rule={rule} busy={busy} save={saveRule} />;
      })}
    </section>
    <section className="panel">
      <div className="section-head">
        <h2>Users</h2>
        <button type="button" className="secondary" onClick={() => setAdding((open) => !open)}>{adding ? 'Close' : 'Add'}</button>
      </div>
      <p className="hint">Staff can use the register. Admins can use the whole portal. admin@admin.com cannot be removed.</p>
      {adding && <form className="rule-row" onSubmit={(event) => void addPerson(event)}>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={6} /></label>
        <label>Permission<select value={permission} onChange={(e) => setPermission(e.target.value as 'staff' | 'admin')}><option value="staff">Staff</option><option value="admin">Admin</option></select></label>
        <label>Paid as<select value={method} onChange={(e) => setMethod(e.target.value as Method)}><option value="percent_profit">Percent of profit</option><option value="percent_sale">Percent of sale</option></select></label>
        <label>Commission
          <select value={commission} onChange={(e) => setCommission(e.target.value)}>
            <option value="0">User only — no commission</option>
            {PERCENTS.map((n) => <option key={n} value={String(n)}>{n}%</option>)}
          </select>
        </label>
        <button disabled={busy || !name.trim() || !username.trim() || password.length < 6}>Add</button>
      </form>}
      {employees.map((row) => {
        const locked = (row.email || '').toLowerCase() === PROTECTED_ADMIN_EMAIL;
        const signIn = row.email?.endsWith('@employees.floor.local') ? row.email.replace(/@employees\.floor\.local$/, '') : (row.email || '');
        return <div className="rule-row" key={row.user_id}>
          <strong>{row.display_name}</strong>
          <span>{signIn}</span>
          <span>{permissionLabel(row.role)}</span>
          {locked
            ? <span>Permanent admin</span>
            : <button type="button" className="text-button" disabled={busy} onClick={() => void removeUser(row)}>Remove</button>}
        </div>;
      })}
    </section>
    {client && <LabelPaperSetting client={client} />}
    {client && <CdtfaAccount client={client} />}
  </>;
}

function CdtfaAccount({ client }: { client: SupabaseClient }) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    void client.rpc('portal_cdtfa_account').then((res) => {
      if (!res.error && res.data) setValue(String(res.data));
    });
  }, [client]);
  return (
    <section className="panel">
      <h2>Sales tax account</h2>
      <p className="hint">CDTFA account number. It is filled onto the return and is not shown in logs.</p>
      <form className="rule-row" onSubmit={(event) => {
        event.preventDefault();
        setError('');
        void client.rpc('portal_set_cdtfa_account', { p_account: value }).then((res) => {
          if (res.error) setError('Could not save the account number.');
          else setSaved('Saved');
        });
      }}>
        <label>Account number<input value={value} autoComplete="off" onChange={(e) => { setValue(e.target.value); setSaved(''); }} /></label>
        <button type="submit">Save</button>
        {saved && <span>{saved}</span>}
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function CommissionRow({ person, rule, busy, save }: {
  person: Person;
  rule?: Rule;
  busy: boolean;
  save: (id: string, method: Method, rate: number) => Promise<void>;
}) {
  const stored = rule && Number(rule.rate) > 0 ? String(Math.round(Number(rule.rate))) : '0';
  const [method, setMethod] = useState<Method>(rule?.method === 'percent_sale' ? 'percent_sale' : 'percent_profit');
  const [rate, setRate] = useState(stored);
  useEffect(() => {
    setMethod(rule?.method === 'percent_sale' ? 'percent_sale' : 'percent_profit');
    setRate(rule && Number(rule.rate) > 0 ? String(Math.round(Number(rule.rate))) : '0');
  }, [rule]);
  const extra = rule && Number(rule.rate) > 0 && !PERCENTS.includes(Math.round(Number(rule.rate))) ? Math.round(Number(rule.rate)) : null;
  return <div className="rule-row">
    <strong>{person.display_name}</strong>
    <select aria-label={`Cut type for ${person.display_name}`} value={method} disabled={busy} onChange={(e) => {
      const next = e.target.value as Method;
      setMethod(next);
      if (Number(rate) > 0) void save(person.user_id, next, Number(rate));
    }}>
      <option value="percent_profit">Percent of profit</option>
      <option value="percent_sale">Percent of sale</option>
    </select>
    <select aria-label={`Commission for ${person.display_name}`} value={rate} disabled={busy} onChange={(e) => {
      const next = e.target.value;
      setRate(next);
      void save(person.user_id, method, Number(next));
    }}>
      <option value="0">User only — no commission</option>
      {extra != null && <option value={String(extra)}>{extra}%</option>}
      {PERCENTS.map((n) => <option key={n} value={String(n)}>{n}%</option>)}
    </select>
  </div>;
}
