import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Budget = { spent_usd: number; reserved_usd: number; monthly_cap_usd: number };
export function VideoScanBudget({ client }: { client: SupabaseClient }) {
  const [budget, setBudget] = useState<Budget | null>(null);
  const [cap, setCap] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; const load = async () => {
    const { data, error: e } = await client.rpc('video_scan_budget');
    if (active) { if (e) setError(e.message); else { setBudget(data as Budget); setCap(String((data as Budget).monthly_cap_usd)); } }
  }; void load(); return () => { active = false; }; }, [client]);
  async function save() {
    const value = Number(cap);
    if (!/^\d+(?:\.\d{1,2})?$/.test(cap) || value > 10000) { setError('Enter a cap from $0 to $10,000.'); return; }
    setBusy(true); setError('');
    const { data, error: e } = await client.rpc('portal_video_scan_set_cap', { p_cap_usd: value });
    if (e) setError(e.message); else setBudget(data as Budget);
    setBusy(false);
  }
  return <section className="panel receive-panel"><h2>AI scan budget</h2>
    <p>{budget ? `$${Number(budget.spent_usd).toFixed(2)} spent this month · $${Number(budget.reserved_usd).toFixed(2)} processing · $${Number(budget.monthly_cap_usd).toFixed(2)} cap` : 'Loading spend…'}</p>
    <label>Monthly hard cap (USD)<input inputMode="decimal" value={cap} onChange={e => { if (/^\d*(?:\.\d{0,2})?$/.test(e.target.value)) setCap(e.target.value); }} /></label>
    <button type="button" className="secondary" disabled={busy} onClick={() => void save()}>Save cap</button>
    {error && <p role="alert" className="alert">{error}</p>}
  </section>;
}
