import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type FeeRate = { pct: number; fixed_cents?: number; min_fee_cents?: number };
type LedgerCfg = {
  channel_fee_rates: Record<string, FeeRate>;
  cost_defaults: Record<string, number>;
  tax_remitted_channels: string[];
  marketplace_channels: { key: string; label?: string }[] | string[];
};

const moneyEntry = /^\d*(?:\.\d{0,2})?$/;
const cleanMoney = (v: string) => (Number(v === '.' ? 0 : v || 0)).toFixed(2);
const RATE_LABELS: Record<string, string> = { card_in_store: 'Card processing — in-store', card_online: 'Card processing — website' };

/** Editable ledger settings: per-channel fee fallbacks, cost defaults, tax remittance. */
export function LedgerSettingsPanel({ client, money, busy, run, onChanged }: {
  client: SupabaseClient; money: (n: number) => string; busy: boolean;
  run: (f: () => Promise<void>) => Promise<void>; onChanged: () => Promise<void>;
}) {
  const [cfg, setCfg] = useState<LedgerCfg | null>(null);
  const [error, setError] = useState('');
  const [newChannel, setNewChannel] = useState('');
  const [newCategory, setNewCategory] = useState('');

  const load = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_ledger_config');
    if (e) { setError(e.message); return; }
    setCfg(data as LedgerCfg);
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  const check = <T,>(r: { data: T | null; error: { message: string } | null }) => { if (r.error) throw new Error(r.error.message); };
  const saveRate = (channel: string, pct: number, fixed: number, min: number | null) => run(async () => {
    check(await client.rpc('portal_set_channel_fee_rate', { p_channel: channel, p_pct: pct, p_fixed_cents: fixed, p_min_fee_cents: min }));
    await load(); await onChanged();
  });
  const deleteRate = (channel: string) => run(async () => {
    check(await client.rpc('portal_delete_channel_fee_rate', { p_channel: channel }));
    await load(); await onChanged();
  });
  const saveDefault = (cat: string, cents: number) => run(async () => {
    check(await client.rpc('portal_set_cost_default', { p_category: cat, p_cents: cents }));
    await load(); await onChanged();
  });
  const deleteDefault = (cat: string) => run(async () => {
    check(await client.rpc('portal_delete_cost_default', { p_category: cat }));
    await load(); await onChanged();
  });
  const toggleRemitted = (channel: string, remitted: boolean) => run(async () => {
    check(await client.rpc('portal_set_tax_remitted', { p_channel: channel, p_remitted: remitted }));
    await load();
  });

  if (error) return <section className="panel"><p className="error">{error}</p></section>;
  if (!cfg) return <section className="panel"><div className="empty">Loading ledger settings…</div></section>;

  const channels = (Array.isArray(cfg.marketplace_channels) ? cfg.marketplace_channels : [])
    .map(c => typeof c === 'string' ? c : c.key);
  const remitted = new Set(cfg.tax_remitted_channels || []);
  const rates = Object.entries(cfg.channel_fee_rates || {}).sort(([a], [b]) => a.localeCompare(b));

  return <>
    <section className="panel">
      <h2>Channel fee rates</h2>
      <p className="hint">Fallback fee for each sales channel, used only when the real fee hasn’t synced yet — such sales are flagged “estimated” and corrected automatically once the actual fee arrives. “Card processing” rates estimate Square’s cut until the real fee syncs.</p>
      {rates.map(([channel, r]) => <FeeRateRow key={channel} channel={channel} label={RATE_LABELS[channel] || channel} rate={r}
        busy={busy} money={money} onSave={saveRate} onDelete={deleteRate} />)}
      <form className="rule-row" onSubmit={e => { e.preventDefault(); const c = newChannel.trim().toLowerCase(); if (c) void saveRate(c, 0, 0, null); setNewChannel(''); }}>
        <label>Add channel<input value={newChannel} placeholder="amazon, tiktok…" onChange={e => setNewChannel(e.target.value)} /></label>
        <button className="secondary" disabled={busy || !newChannel.trim()}>Add</button>
      </form>
    </section>
    <section className="panel">
      <h2>Cost defaults</h2>
      <p className="hint">When a sold unit has no recorded cost, the matching category default is used so profit and payouts still calculate — flagged “estimated” on the sale. Collectibles are always $0. Fill in real costs on the Missing cost page anytime; profit updates instantly.</p>
      {Object.entries(cfg.cost_defaults || {}).sort(([a], [b]) => a === 'other' ? 1 : b === 'other' ? -1 : a.localeCompare(b)).map(([cat, cents]) =>
        <CostRow key={cat} category={cat} cents={cents} busy={busy} money={money} onSave={saveDefault} onDelete={deleteDefault} />)}
      <form className="rule-row" onSubmit={e => { e.preventDefault(); const c = newCategory.trim().toLowerCase(); if (c) void saveDefault(c, 0); setNewCategory(''); }}>
        <label>Add category<input value={newCategory} placeholder="washers, tools…" onChange={e => setNewCategory(e.target.value)} /></label>
        <button className="secondary" disabled={busy || !newCategory.trim()}>Add</button>
      </form>
    </section>
    <section className="panel">
      <h2>Sales tax remitted by marketplace</h2>
      <p className="hint">Checked channels collect and remit sales tax themselves — it appears on reports as collected but never as tax we owe. Unchecked channels mean we collected it and owe it (in-store and website use the store tax rate).</p>
      <div className="tax-channel-list">{channels.map(c => <label key={c} className="check">
        <input type="checkbox" disabled={busy} checked={remitted.has(c)} onChange={e => void toggleRemitted(c, e.target.checked)} /> {c}
      </label>)}</div>
    </section>
  </>;
}

function FeeRateRow({ channel, label, rate, busy, money, onSave, onDelete }: {
  channel: string; label: string; rate: FeeRate; busy: boolean; money: (n: number) => string;
  onSave: (c: string, pct: number, fixed: number, min: number | null) => Promise<void>;
  onDelete: (c: string) => Promise<void>;
}) {
  const [pct, setPct] = useState(String(rate.pct));
  const [fixed, setFixed] = useState(((rate.fixed_cents || 0) / 100).toFixed(2));
  const [min, setMin] = useState(rate.min_fee_cents != null ? (rate.min_fee_cents / 100).toFixed(2) : '');
  useEffect(() => { setPct(String(rate.pct)); setFixed(((rate.fixed_cents || 0) / 100).toFixed(2)); setMin(rate.min_fee_cents != null ? (rate.min_fee_cents / 100).toFixed(2) : ''); }, [rate]);
  return <form className="rule-row" onSubmit={e => { e.preventDefault(); void onSave(channel, Number(pct), Math.round(Number(fixed) * 100), min === '' ? null : Math.round(Number(min) * 100)); }}>
    <strong>{label}</strong>
    <label><input type="number" min={0} max={99} step="0.01" required value={pct} onChange={e => setPct(e.target.value)} />%</label>
    <label>+ $<input type="text" inputMode="decimal" value={fixed} onChange={e => { if (moneyEntry.test(e.target.value)) setFixed(e.target.value); }} onBlur={() => setFixed(cleanMoney(fixed))} /></label>
    <label>min $<input type="text" inputMode="decimal" value={min} placeholder={money(0).slice(1)} onChange={e => { if (moneyEntry.test(e.target.value)) setMin(e.target.value); }} onBlur={() => { if (min) setMin(cleanMoney(min)); }} /></label>
    <button disabled={busy}>Save</button>
    <button type="button" className="text-button" disabled={busy} onClick={() => void onDelete(channel)}>Remove</button>
  </form>;
}

function CostRow({ category, cents, busy, money, onSave, onDelete }: {
  category: string; cents: number; busy: boolean; money: (n: number) => string;
  onSave: (c: string, cents: number) => Promise<void>; onDelete: (c: string) => Promise<void>;
}) {
  const [text, setText] = useState((cents / 100).toFixed(2));
  useEffect(() => setText((cents / 100).toFixed(2)), [cents]);
  return <form className="rule-row" onSubmit={e => { e.preventDefault(); void onSave(category, Math.round(Number(text) * 100)); }}>
    <strong>{category === 'other' ? 'Everything else' : category}</strong>
    <label>$<input type="text" inputMode="decimal" value={text} onChange={e => { if (moneyEntry.test(e.target.value)) setText(e.target.value); }} onBlur={() => setText(cleanMoney(text))} /></label>
    <button disabled={busy}>Save</button>
    {category !== 'other' && <button type="button" className="text-button" disabled={busy} onClick={() => void onDelete(category)}>Remove</button>}
  </form>;
}
