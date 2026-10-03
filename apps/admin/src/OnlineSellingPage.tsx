import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

const functionsBase = (import.meta.env.VITE_FLOOR_FUNCTIONS_URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');

type Settings = {
  ship_excluded_categories: string[]; ship_excluded_keywords: string[];
  ship_max_weight_lb: number; ship_max_length_in: number; ship_max_length_girth_in: number;
  pickup_hold_hours: number; order_notify_emails: string[]; categories: string[];
  counts: { listed: number; shippable: number; pickup_only: number; missing_dims: number };
  pickup_only_units: { sku: string; title: string; category: string | null; reason: string }[];
};
type Check = { id: number; ran_at: string; ok: boolean; counts: Record<string, number>; problems: { sku: string | null; title: string | null; where: string; reason: string }[]; healed: unknown[]; emailed_at: string | null; error: string | null };
type Props = { client: SupabaseClient; accessToken: string; stamp: (s: string) => string };

const lines = (s: string) => s.split(/[\n,]/).map(x => x.trim()).filter(Boolean);

export function OnlineSellingPage({ client, accessToken, stamp }: Props) {
  const [s, setS] = useState<Settings | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState(''); const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [emails, setEmails] = useState(''); const [keywords, setKeywords] = useState(''); const [cats, setCats] = useState<string[]>([]);
  const [extraCats, setExtraCats] = useState('');
  const [nums, setNums] = useState({ ship_max_weight_lb: '', ship_max_length_in: '', ship_max_length_girth_in: '', pickup_hold_hours: '' });

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([client.rpc('portal_online_settings'), client.from('listing_checks').select('*').order('ran_at', { ascending: false }).limit(1)]);
    if (a.error) { setError(a.error.message); return; }
    const v = a.data as Settings; setS(v);
    setEmails(v.order_notify_emails.join('\n')); setKeywords(v.ship_excluded_keywords.join('\n'));
    const known = new Set(v.categories.map(c => c.toLowerCase()));
    setCats(v.ship_excluded_categories.filter(c => known.has(c.toLowerCase())));
    setExtraCats(v.ship_excluded_categories.filter(c => !known.has(c.toLowerCase())).join('\n'));
    setNums({ ship_max_weight_lb: String(v.ship_max_weight_lb), ship_max_length_in: String(v.ship_max_length_in), ship_max_length_girth_in: String(v.ship_max_length_girth_in), pickup_hold_hours: String(v.pickup_hold_hours) });
    if (!b.error) setCheck((b.data?.[0] as Check) || null);
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true); setError(''); setSaved('');
    try {
      const put = async (key: string, value: unknown) => { const { error: e } = await client.rpc('portal_set_online_setting', { p_key: key, p_value: value }); if (e) throw new Error(`${key}: ${e.message}`); };
      await put('order_notify_emails', lines(emails));
      await put('ship_excluded_categories', [...cats, ...lines(extraCats)]);
      await put('ship_excluded_keywords', lines(keywords));
      for (const [k, v] of Object.entries(nums)) await put(k, Number(v));
      setSaved('Saved. The website uses the new rules immediately.'); await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function runCheck() {
    setBusy(true); setError(''); setSaved('');
    try {
      const res = await fetch(`${functionsBase}/.netlify/functions/listing-check-background`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: '{}' });
      if (res.status !== 202) throw new Error(`Could not start the check (${res.status})`);
      setSaved('Check started. Results appear here in about a minute.');
      setTimeout(() => { void load(); }, 45000);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!s) return <><header><div><div className="eyebrow">WEBSITE</div><h1>Online selling</h1></div></header>{error ? <div className="alert">{error}</div> : <p className="hint">Loading…</p>}</>;
  return <>
    <header><div><div className="eyebrow">WEBSITE</div><h1>Online selling</h1><p>Every listed unit can be bought online for store pickup. Shipping is offered only when the rules below allow it and the unit has package dimensions and weight.</p></div></header>
    {error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    {saved && <div className="notice">{saved}</div>}
    <div className="stats"><div className="stat"><span>Listed online</span><strong>{s.counts.listed}</strong></div><div className="stat"><span>Ship or pickup</span><strong>{s.counts.shippable}</strong></div><div className="stat"><span>Pickup only</span><strong>{s.counts.pickup_only}</strong></div><div className="stat"><span>Missing package dims/weight</span><strong>{s.counts.missing_dims}</strong></div></div>

    <section className="panel"><div className="section-head"><h2>Website listing check</h2><button className="secondary" disabled={busy} onClick={() => void runCheck()}>Run check now</button></div>
      {!check ? <div className="empty">No check has run yet. It runs daily at 7 am.</div> : <>
        <p><strong className={check.ok ? 'ok-text' : 'bad-text'}>{check.ok ? 'All listable units are live' : `${check.problems.length} problem(s)`}</strong> · {stamp(check.ran_at)}{check.emailed_at ? ' · emailed' : ''}</p>
        <p className="hint">Floor listable {check.counts.floor_listable ?? '—'} · Storefront {check.counts.storefront_view ?? '—'} · Website {check.counts.website ?? '—'} · Catalog feed {check.counts.catalog_feed ?? '—'}</p>
        {check.problems.length > 0 && <div className="inventory-listings">{check.problems.map((p, i) => <div key={i}><strong>SKU {p.sku ?? '—'}{p.title ? ` · ${p.title}` : ''}</strong><span>{p.reason}</span></div>)}</div>}
      </>}
    </section>

    <section className="panel"><h2>Order notifications</h2><label className="notes">Email every new online order, cancellation and listing-check problem to (one per line)<textarea rows={3} value={emails} onChange={e => setEmails(e.target.value)} /></label></section>

    <section className="panel"><h2>Shipping rules</h2>
      <h3>Pickup-only categories</h3><div className="check-grid">{s.categories.map(c => <label key={c}><input type="checkbox" checked={cats.some(x => x.toLowerCase() === c.toLowerCase())} onChange={e => setCats(e.target.checked ? [...cats, c] : cats.filter(x => x.toLowerCase() !== c.toLowerCase()))} />{c}</label>)}</div>
      <label className="notes">Other pickup-only category names (for categories added later)<textarea rows={3} value={extraCats} onChange={e => setExtraCats(e.target.value)} /></label>
      <label className="notes">Pickup-only words in the title (whole words)<textarea rows={4} value={keywords} onChange={e => setKeywords(e.target.value)} /></label>
      <div className="number-grid">
        <label>Max package weight (lb)<input inputMode="decimal" value={nums.ship_max_weight_lb} onChange={e => setNums({ ...nums, ship_max_weight_lb: e.target.value })} /></label>
        <label>Max longest side (in)<input inputMode="decimal" value={nums.ship_max_length_in} onChange={e => setNums({ ...nums, ship_max_length_in: e.target.value })} /></label>
        <label>Max length + girth (in)<input inputMode="decimal" value={nums.ship_max_length_girth_in} onChange={e => setNums({ ...nums, ship_max_length_girth_in: e.target.value })} /></label>
        <label>Pickup window (hours)<input inputMode="numeric" value={nums.pickup_hold_hours} onChange={e => setNums({ ...nums, pickup_hold_hours: e.target.value })} /></label>
      </div>
      <p className="hint">Carrier limits: USPS 70 lb and 130 in length + girth; UPS 150 lb, 108 in longest side, 165 in length + girth. A pickup deadline that lands when the store is closed moves to closing time on the next open day. Per-unit overrides (force ship / pickup only) are in Inventory → unit.</p>
      <button disabled={busy} onClick={() => void save()}>Save settings</button>
    </section>

    <section className="panel"><details><summary>Pickup-only units ({s.pickup_only_units.length})</summary><div className="inventory-listings">{s.pickup_only_units.map(u => <div key={u.sku}><strong>SKU {u.sku} · {u.title}</strong><span>{u.reason}</span></div>)}</div></details></section>
  </>;
}
