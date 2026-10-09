import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type RuleRow = {
  channel: string; enabled: boolean; rules: Record<string, unknown>; notes: string | null;
  updated_at: string; strike_count: number;
};
type Strike = {
  id: number; channel: string; sku: string; struck_at: string; reason: string;
  email_body: string | null; created_at: string; created_by_name: string | null;
};
type Review = {
  id: number; sku: string; channel: string; reason: string; status: string;
  created_at: string; title: string | null;
};
type Elig = {
  channel: string; status: string; reason: string; source: string;
  override?: { decision: string; note: string } | null; strike?: boolean;
};
type Props = { client: SupabaseClient; stamp: (s: string) => string; embedded?: boolean };

const boolKeys = [
  'block_requires_power', 'block_chargers_cables', 'allow_cameras', 'require_own_photos',
  'block_stock_photos', 'block_ai_images', 'block_manufacturer_photos', 'review_if_power_unknown',
] as const;

function lines(value: unknown) {
  return Array.isArray(value) ? value.map(String).join('\n') : '';
}
function parseLines(s: string) {
  return s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
}

export function EligibilityPage({ client, stamp, embedded }: Props) {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [strikes, setStrikes] = useState<Strike[]>([]);
  const [review, setReview] = useState<Review[]>([]);
  const [channel, setChannel] = useState('depop');
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [notes, setNotes] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [sku, setSku] = useState('');
  const [elig, setElig] = useState<Elig[]>([]);
  const [strikeForm, setStrikeForm] = useState({ channel: 'depop', sku: '', reason: '', email: '', date: '' });
  const [overrideForm, setOverrideForm] = useState({ channel: 'depop', decision: 'allow', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setError('');
    const [a, b, c] = await Promise.all([
      client.rpc('portal_marketplace_policy_rules'),
      client.rpc('portal_policy_strikes'),
      client.rpc('portal_eligibility_review_queue'),
    ]);
    for (const x of [a, b, c]) if (x.error) throw x.error;
    const rows = (a.data || []) as RuleRow[];
    setRules(rows);
    setStrikes((b.data || []) as Strike[]);
    setReview((c.data || []) as Review[]);
    const current = rows.find((r) => r.channel === channel) || rows[0];
    if (current) {
      setChannel(current.channel);
      setDraft({ ...(current.rules || {}) });
      setNotes(current.notes || '');
      setEnabled(current.enabled);
    }
  }, [client, channel]);

  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : String(e))); }, [load]);

  useEffect(() => {
    const current = rules.find((r) => r.channel === channel);
    if (!current) return;
    setDraft({ ...(current.rules || {}) });
    setNotes(current.notes || '');
    setEnabled(current.enabled);
  }, [channel, rules]);

  const strikeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rules) m.set(r.channel, Number(r.strike_count) || 0);
    return m;
  }, [rules]);

  async function saveRules() {
    setBusy(true); setError(''); setNotice('');
    try {
      const next: Record<string, unknown> = {
        ...draft,
        blocked_keywords: parseLines(String(draft.blocked_keywords_text ?? lines(draft.blocked_keywords))),
        blocked_categories: parseLines(String(draft.blocked_categories_text ?? lines(draft.blocked_categories))),
        prohibited_keywords: parseLines(String(draft.prohibited_keywords_text ?? lines(draft.prohibited_keywords))),
      };
      delete next.blocked_keywords_text;
      delete next.blocked_categories_text;
      delete next.prohibited_keywords_text;
      const { error: e } = await client.rpc('portal_set_marketplace_policy_rule', {
        p_channel: channel, p_enabled: enabled, p_rules: next, p_notes: notes || null,
      });
      if (e) throw e;
      setNotice(`Saved ${channel} rules.`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function lookupSku() {
    if (!sku.trim()) return;
    setBusy(true); setError('');
    try {
      const { data, error: e } = await client.rpc('portal_unit_eligibility', { p_sku: sku.trim() });
      if (e) throw e;
      setElig((data || []) as Elig[]);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function saveOverride() {
    setBusy(true); setError(''); setNotice('');
    try {
      const { error: e } = await client.rpc('portal_set_unit_eligibility_override', {
        p_sku: sku.trim(),
        p_channel: overrideForm.channel,
        p_decision: overrideForm.decision,
        p_note: overrideForm.note,
      });
      if (e) throw e;
      setNotice(`Override saved for SKU ${sku.trim()} on ${overrideForm.channel}.`);
      await lookupSku();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function clearOverride(ch: string) {
    setBusy(true); setError('');
    try {
      const { error: e } = await client.rpc('portal_set_unit_eligibility_override', {
        p_sku: sku.trim(), p_channel: ch, p_decision: null, p_note: null,
      });
      if (e) throw e;
      await lookupSku();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function logStrike() {
    setBusy(true); setError(''); setNotice('');
    try {
      const { error: e } = await client.rpc('portal_log_policy_strike', {
        p_channel: strikeForm.channel,
        p_sku: strikeForm.sku.trim(),
        p_reason: strikeForm.reason.trim(),
        p_email_body: strikeForm.email.trim() || null,
        p_struck_at: strikeForm.date || null,
      });
      if (e) throw e;
      setNotice(`Strike logged for SKU ${strikeForm.sku} on ${strikeForm.channel}. That SKU is permanently blocked there.`);
      setStrikeForm({ channel: 'depop', sku: '', reason: '', email: '', date: '' });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return <>
    {embedded ? <section className="panel"><div className="section-head"><div><h2>Marketplace eligibility</h2>
      <p className="hint" style={{ margin: 0 }}>Per-channel policy rules, overrides, review queue, and strike log.</p></div>
      <button className="secondary" disabled={busy} onClick={() => void load()}>Refresh</button></div></section>
    : <header>
      <div>
        <div className="eyebrow">ACCOUNT RISK</div>
        <h1>Marketplace eligibility</h1>
        <p>Editable per-channel policy rules, unit overrides, review queue, and policy-strike log. When in doubt the system blocks and queues for review.</p>
      </div>
      <button className="secondary" disabled={busy} onClick={() => void load()}>Refresh</button>
    </header>}
    {error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    {notice && <div className="notice">{notice}</div>}

    <div className="stats">
      {rules.map((r) => <div className="stat" key={r.channel}>
        <span>{r.channel}</span>
        <strong>{strikeCounts.get(r.channel) || 0}</strong>
        <small>{r.enabled ? 'rules on' : 'disabled'} · strikes</small>
      </div>)}
      <div className="stat"><span>Review queue</span><strong>{review.length}</strong></div>
    </div>

    <section className="panel">
      <div className="section-head"><h2>Policy rules</h2>
        <label>Channel<select value={channel} onChange={(e) => setChannel(e.target.value)}>
          {rules.map((r) => <option key={r.channel} value={r.channel}>{r.channel}</option>)}
        </select></label>
      </div>
      <p className="hint">Changes apply immediately to Vendoo export, Floor listing toggles, eBay drafts, website listing, and Google sync. No code deploy needed.</p>
      <label className="inventory-check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Rules enabled for {channel}</label>
      <div className="check-grid" style={{ marginTop: 12 }}>
        {boolKeys.map((key) => <label key={key}>
          <input type="checkbox" checked={Boolean(draft[key])} onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })} />
          {key.replace(/_/g, ' ')}
        </label>)}
      </div>
      <label className="notes">Blocked keywords (one per line)<textarea rows={4} value={String(draft.blocked_keywords_text ?? lines(draft.blocked_keywords))} onChange={(e) => setDraft({ ...draft, blocked_keywords_text: e.target.value })} /></label>
      <label className="notes">Blocked categories<textarea rows={3} value={String(draft.blocked_categories_text ?? lines(draft.blocked_categories))} onChange={(e) => setDraft({ ...draft, blocked_categories_text: e.target.value })} /></label>
      <label className="notes">Prohibited keywords<textarea rows={3} value={String(draft.prohibited_keywords_text ?? lines(draft.prohibited_keywords))} onChange={(e) => setDraft({ ...draft, prohibited_keywords_text: e.target.value })} /></label>
      <label className="notes">Notes<textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <div className="actions"><button disabled={busy} onClick={() => void saveRules()}>Save {channel} rules</button></div>
    </section>

    <section className="panel">
      <h2>Unit eligibility</h2>
      <div className="actions">
        <label>SKU<input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="e.g. 11246" /></label>
        <button disabled={busy || !sku.trim()} onClick={() => void lookupSku()}>Check</button>
      </div>
      {elig.length > 0 && <div className="inventory-listings" style={{ marginTop: 12 }}>
        {elig.map((row) => <div key={row.channel}>
          <strong>{row.channel} · {row.status}</strong>
          <span>{row.reason}{row.strike ? ' · STRIKE' : ''}{row.override ? ` · override ${row.override.decision}` : ''}</span>
          {row.override && <button className="text-button" disabled={busy} onClick={() => void clearOverride(row.channel)}>Clear override</button>}
        </div>)}
      </div>}
      {sku.trim() && <div className="actions" style={{ marginTop: 12 }}>
        <label>Override channel<select value={overrideForm.channel} onChange={(e) => setOverrideForm({ ...overrideForm, channel: e.target.value })}>
          {rules.map((r) => <option key={r.channel} value={r.channel}>{r.channel}</option>)}
        </select></label>
        <label>Decision<select value={overrideForm.decision} onChange={(e) => setOverrideForm({ ...overrideForm, decision: e.target.value })}>
          <option value="allow">Allow</option><option value="block">Block</option>
        </select></label>
        <label>Note<input value={overrideForm.note} onChange={(e) => setOverrideForm({ ...overrideForm, note: e.target.value })} placeholder="Required reason" /></label>
        <button disabled={busy || !overrideForm.note.trim()} onClick={() => void saveOverride()}>Save override</button>
      </div>}
      <p className="hint">Overrides cannot bypass a logged policy strike. Strikes permanently block that SKU on that marketplace.</p>
    </section>

    <section className="panel">
      <h2>Review queue</h2>
      {review.length === 0 ? <div className="empty">No items waiting for eligibility review.</div> : <div className="ticket-list">
        {review.map((r) => <div className="ticket" key={r.id}>
          <strong>SKU {r.sku} · {r.channel}</strong>
          <small>{r.title || 'Untitled'} · {r.reason} · {stamp(r.created_at)}</small>
          <button className="secondary" disabled={busy} onClick={() => {
            setSku(r.sku); setOverrideForm({ channel: r.channel, decision: 'allow', note: '' });
            void client.rpc('portal_resolve_eligibility_review', { p_id: r.id, p_note: 'Opened from review queue' }).then(() => load());
          }}>Open / dismiss</button>
        </div>)}
      </div>}
    </section>

    <section className="panel">
      <h2>Log policy strike</h2>
      <div className="actions">
        <label>Marketplace<select value={strikeForm.channel} onChange={(e) => setStrikeForm({ ...strikeForm, channel: e.target.value })}>
          {rules.map((r) => <option key={r.channel} value={r.channel}>{r.channel}</option>)}
        </select></label>
        <label>SKU<input value={strikeForm.sku} onChange={(e) => setStrikeForm({ ...strikeForm, sku: e.target.value })} /></label>
        <label>Date<input type="date" value={strikeForm.date} onChange={(e) => setStrikeForm({ ...strikeForm, date: e.target.value })} /></label>
      </div>
      <label className="notes">Reason<textarea rows={2} value={strikeForm.reason} onChange={(e) => setStrikeForm({ ...strikeForm, reason: e.target.value })} placeholder="Depop Electronics Policy — rechargeable toothbrush" /></label>
      <label className="notes">Email / notice text<textarea rows={4} value={strikeForm.email} onChange={(e) => setStrikeForm({ ...strikeForm, email: e.target.value })} placeholder="Paste what the marketplace email said" /></label>
      <button disabled={busy || !strikeForm.sku.trim() || !strikeForm.reason.trim()} onClick={() => void logStrike()}>Log strike (permanent block)</button>
    </section>

    <section className="panel">
      <h2>Strike history</h2>
      {strikes.length === 0 ? <div className="empty">No strikes logged yet.</div> : <div className="ticket-list">
        {strikes.map((s) => <div className="ticket" key={s.id}>
          <strong>{s.channel} · SKU {s.sku} · {s.struck_at}</strong>
          <small>{s.reason}</small>
          {s.email_body && <small>{s.email_body}</small>}
          <small>Logged {stamp(s.created_at)}{s.created_by_name ? ` · ${s.created_by_name}` : ''}</small>
        </div>)}
      </div>}
    </section>
  </>;
}
