import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';
export function DnsCheckbox({ client, sku, onChanged }: { client: SupabaseClient; sku: string; onChanged: (dns: boolean) => void }) {
  const [value, setValue] = useState<{ dns: boolean; required: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { let alive = true; void Promise.resolve(client.rpc('portal_unit_dns', { p_sku: sku })).then(({ data, error: e }) => {
    if (!alive) return; if (e) setError(errText(e)); else setValue(data);
  }); return () => { alive = false; }; }, [client, sku]);
  async function change(dns: boolean) {
    setBusy(true); setError('');
    const { data, error: e } = await client.rpc('portal_set_unit_dns', { p_sku: sku, p_dns: dns });
    if (e) setError(errText(e)); else { setValue(data); onChanged(data.dns); }
    setBusy(false);
  }
  return <div className="unit-edit-wide">
    <label className="mboard-inline"><input type="checkbox" checked={!!value?.dns} disabled={busy || !value || value.required} onChange={e => void change(e.target.checked)} /> DNS — Do not ship</label>
    <p className="hint">Store / website pickup only. Never listed on eBay, Amazon, TikTok Shop or Depop.{value?.required ? ' Required for this oversized item type.' : ''}</p>
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
