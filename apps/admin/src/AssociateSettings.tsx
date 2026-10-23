import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';

type Props = {
  client: SupabaseClient;
  displayName: string;
};

export function AssociateSettings({ client, displayName }: Props) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setOk('');
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const { error: err } = await client.auth.updateUser({ password });
      if (err) throw err;
      setPassword('');
      setConfirm('');
      setOk('Password updated.');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <header>
      <div>
        <div className="eyebrow">ASSOCIATE</div>
        <h1>Settings</h1>
        <p>Signed in as {displayName}. Change your portal password here.</p>
      </div>
    </header>
    <section className="panel">
      <h2>Change password</h2>
      <form className="payment-form" style={{ maxWidth: 360 }} onSubmit={e => void save(e)}>
        <label>New password
          <input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required />
        </label>
        <label>Confirm password
          <input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
        </label>
        <button disabled={busy}>{busy ? 'Saving…' : 'Update password'}</button>
      </form>
      {error && <p className="error" style={{ marginTop: 12 }}>{error}</p>}
      {ok && <p className="hint" style={{ marginTop: 12 }}>{ok}</p>}
      <p className="hint" style={{ marginTop: 16 }}>
        Sign in with clock number <strong>1111</strong> and your password (no email needed).
      </p>
    </section>
  </>;
}
