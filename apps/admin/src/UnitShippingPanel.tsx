import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Info = { override: 'ship' | 'pickup' | null; check: { ship: boolean; reason: string }; listed: boolean;
  package_length_in: number | null; package_width_in: number | null; package_height_in: number | null; package_weight_lb: number | null; dims_source: string | null };
const num = (v: string) => (v.trim() === '' ? null : Number(v));

/** Per-unit online fulfillment: auto / force ship / pickup only, plus package dimensions and weight. */
export function UnitShippingPanel({ client, sku }: { client: SupabaseClient; sku: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [form, setForm] = useState({ override: '', l: '', w: '', h: '', lb: '' });
  const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);

  function apply(v: Info) {
    setInfo(v);
    const s = (x: number | null) => (x == null ? '' : String(x));
    setForm({ override: v.override || '', l: s(v.package_length_in), w: s(v.package_width_in), h: s(v.package_height_in), lb: s(v.package_weight_lb) });
  }
  useEffect(() => { void client.rpc('portal_unit_shipping', { p_sku: sku }).then(({ data, error }) => { if (error) setMsg(error.message); else if (data) apply(data as Info); }); }, [client, sku]);

  async function save() {
    const vals = [form.l, form.w, form.h, form.lb].map(num);
    if (vals.some(v => v !== null && !(Number.isFinite(v) && v > 0))) { setMsg('Dimensions and weight must be positive numbers.'); return; }
    setBusy(true); setMsg('');
    const { data, error } = await client.rpc('portal_set_unit_shipping', { p_sku: sku, p_override: form.override, p_length: vals[0], p_width: vals[1], p_height: vals[2], p_weight: vals[3] });
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    apply(data as Info); setMsg('Saved.');
  }

  if (!info) return <><h3>Online selling</h3><p className="hint">{msg || 'Loading…'}</p></>;
  return <>
    <h3>Online selling</h3>
    <p><strong>{info.check.ship ? 'Ship or store pickup' : 'Store pickup only'}</strong> · {info.check.reason}{info.listed ? '' : ' · not currently listed on the website'}</p>
    <div className="number-grid">
      <label>Shipping<select value={form.override} onChange={e => setForm({ ...form, override: e.target.value })}><option value="">Automatic (rules)</option><option value="ship">Force shippable</option><option value="pickup">Pickup only</option></select></label>
      <label>Package length (in)<input inputMode="decimal" value={form.l} onChange={e => setForm({ ...form, l: e.target.value })} /></label>
      <label>Package width (in)<input inputMode="decimal" value={form.w} onChange={e => setForm({ ...form, w: e.target.value })} /></label>
      <label>Package height (in)<input inputMode="decimal" value={form.h} onChange={e => setForm({ ...form, h: e.target.value })} /></label>
      <label>Package weight (lb)<input inputMode="decimal" value={form.lb} onChange={e => setForm({ ...form, lb: e.target.value })} /></label>
    </div>
    {info.dims_source && <p className="hint">Dimensions are {info.dims_source}.</p>}
    <div className="actions"><button disabled={busy} onClick={() => void save()}>Save shipping</button>{msg && <span className="hint">{msg}</span>}</div>
  </>;
}
