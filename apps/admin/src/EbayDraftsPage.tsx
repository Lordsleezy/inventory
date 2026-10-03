import { useCallback, useEffect, useState } from 'react';

const functionsBase = (import.meta.env.VITE_FLOOR_FUNCTIONS_URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');

type Fail = string;
type Summary = {
  sku: string; title: string | null; status: string; ready: boolean; price_cents: number | null;
  shipping_mode: string | null; label_cents: number | null; label_source: string | null;
  category_name: string | null; category_id: string | null; photo_url: string | null;
  fails: Fail[]; ebay_error: string | null; view_url: string | null; listing_id: string | null;
};
type Aspect = { name: string; required: boolean; recommended: boolean; allowed: string[]; selectionOnly: boolean };
type Draft = Summary & {
  description: string | null; condition_id: string | null; condition_notes: string | null;
  suggestions: { categoryId: string; categoryName: string }[];
  conditions: { conditionId: string; name: string }[];
  aspect_defs: Aspect[]; aspects: Record<string, string>;
  photos: { path: string; url: string }[];
  box: { length_in: number | null; width_in: number | null; height_in: number | null; weight_lb: number | null };
  floor_condition: string; checklist: { ok: boolean; label: string }[];
};
type Settings = { feePct: number; perOrderCents: number; cutoffCents: number; ending: number; farZip: string };
type Props = { accessToken: string; money: (n: number) => string };

async function call(token: string, body: Record<string, unknown>) {
  const res = await fetch(`${functionsBase}/.netlify/functions/ebay-drafts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function EbayDraftsPage({ accessToken, money }: Props) {
  const [rows, setRows] = useState<Summary[] | null>(null);
  const [counts, setCounts] = useState({ total: 0, ready: 0, needsBox: 0, live: 0 });
  const [connected, setConnected] = useState<boolean | null>(null);
  const [policies, setPolicies] = useState<{ ok?: boolean; missing?: string[] } | null>(null);
  const [settings, setSettings] = useState<Settings>({ feePct: 13.25, perOrderCents: 40, cutoffCents: 1500, ending: 99, farZip: '10001' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await call(accessToken, { action: 'list' });
    setRows(data.drafts || []);
    setCounts(data.counts || { total: 0, ready: 0, needsBox: 0, live: 0 });
    setConnected(Boolean(data.connected));
    setPolicies(data.policies);
    if (data.settings) setSettings(data.settings);
  }, [accessToken]);

  useEffect(() => { void load().catch((e) => setError(e.message)); }, [load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function open(sku: string) {
    await run(async () => { const data = await call(accessToken, { action: 'prepare', sku }); setDraft(data.draft); });
  }
  async function save(fields: Record<string, unknown>) {
    if (!draft) return;
    await run(async () => { const data = await call(accessToken, { action: 'save', sku: draft.sku, fields }); setDraft(data.draft); await load(); });
  }
  function toggle(sku: string) {
    setPicked((cur) => cur.includes(sku) ? cur.filter((s) => s !== sku) : [...cur, sku]);
  }

  return <>
    <header><div><div className="eyebrow">EBAY</div><h1>eBay drafts</h1>
      <p>Drafts stay in Floor until you push them. New eligible units appear on their own. Sold, delisted, and ineligible units drop off.</p></div>
      <div className="actions">
        <button className="secondary" disabled={busy} onClick={() => void run(load)}>Refresh</button>
        <button disabled={busy || picked.length === 0} onClick={() => void run(async () => {
          const data = await call(accessToken, { action: 'push', skus: picked });
          const failed = (data.results || []).filter((r: { ok: boolean; sku: string; error?: string }) => !r.ok);
          setPicked([]); setDraft(null); await load();
          if (failed.length) setError(failed.map((r: { sku: string; error?: string }) => `SKU ${r.sku}: ${r.error}`).join(' '));
        })}>Push selected</button>
      </div></header>
    {error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    <div className="stats"><div className="stat"><span>Drafts</span><strong>{counts.total}</strong></div><div className="stat"><span>Ready to push</span><strong>{counts.ready}</strong></div><div className="stat"><span>Need box size</span><strong>{counts.needsBox}</strong></div><div className="stat"><span>Live</span><strong>{counts.live}</strong></div></div>

    <section className="panel"><h2>Connection and price</h2>
      <p>{connected ? 'eBay account is connected.' : 'eBay is not connected yet.'} {policies && !policies.ok && policies.missing?.length ? `Policies still needed: ${policies.missing.join(', ')}.` : ''}</p>
      <div className="actions">
        <button disabled={busy} onClick={() => void run(async () => { const data = await call(accessToken, { action: 'connect' }); window.location.href = data.url; })}>Connect eBay account</button>
        <button className="secondary" disabled={busy || !connected} onClick={() => void run(async () => { const data = await call(accessToken, { action: 'check_policies' }); setPolicies(data.policies); if (data.error) setError(data.error); })}>Check business policies</button>
      </div>
      <SettingsForm settings={settings} busy={busy} onSave={(next) => void run(async () => { await call(accessToken, { action: 'save_settings', settings: next }); await load(); })} />
      <p className="hint">Label cost is quoted from 95663 to the far-zone ZIP. At or under the cutoff, shipping is free and the label is baked into the eBay price. Over the cutoff, the buyer pays calculated shipping.</p>
    </section>

    <div className="ebay-layout">
      <section className="panel">{rows === null ? <p className="hint">Loading drafts…</p> : rows.length === 0 ? <div className="empty">No drafts. Eligible units need a photo and a price, and they cannot be oversized or prohibited.</div> : <div className="ticket-list">{rows.map((row) => <div className="ticket ebay-row" key={row.sku}>
        <label className="reimburse-check"><input type="checkbox" disabled={!row.ready || row.status === 'live'} checked={picked.includes(row.sku)} onChange={() => toggle(row.sku)} /></label>
        <button className="inventory-row" onClick={() => void open(row.sku)}>
          <span className="inventory-photo">{row.photo_url ? <img src={row.photo_url} alt="" /> : 'No photo'}</span>
          <span className="inventory-identity"><strong>{row.title || `SKU ${row.sku}`}</strong><small>SKU {row.sku}{row.category_name ? ` · ${row.category_name}` : ''}</small></span>
          <span className="inventory-meta"><small>{row.price_cents != null ? money(row.price_cents) : 'No price'} · {row.shipping_mode === 'free' ? 'Free shipping' : row.shipping_mode === 'calculated' ? 'Calculated shipping' : 'Shipping TBD'}{row.label_cents != null ? ` · label ${money(row.label_cents)}` : ''}</small></span>
          <span>{row.status === 'live' ? <b className="tag on">Live</b> : row.ready ? <b className="tag on">Ready</b> : <b className="tag warn">{row.fails[0] || 'Needs work'}</b>}</span>
        </button>
      </div>)}</div>}</section>

      {draft && <section className="panel ebay-editor"><div className="section-head"><h2>SKU {draft.sku}</h2><button className="text-button" onClick={() => setDraft(null)}>Close</button></div>
        {draft.status === 'live' && draft.view_url && <p><b className="tag on">Live</b> <a href={draft.view_url} target="_blank" rel="noreferrer">Open on eBay</a></p>}
        {draft.ebay_error && <div className="alert" role="alert">{draft.ebay_error}</div>}
        <div className="ebay-photos">{draft.photos.map((photo, i) => <figure key={photo.path}><img src={photo.url} alt="" />{i === 0 && <figcaption>Main</figcaption>}<div className="actions"><button className="secondary" disabled={i === 0 || busy} onClick={() => { const photos = [...draft.photos]; const [moved] = photos.splice(i, 1); photos.unshift(moved); void save({ photo_paths: photos.map((p) => p.path) }); }}>Make main</button>{i > 0 && <button className="secondary" disabled={busy} onClick={() => { const photos = [...draft.photos]; [photos[i - 1], photos[i]] = [photos[i], photos[i - 1]]; void save({ photo_paths: photos.map((p) => p.path) }); }}>Left</button>}</div></figure>)}</div>
        <label className="notes">Title<input value={draft.title || ''} maxLength={80} onChange={(e) => setDraft({ ...draft, title: e.target.value })} onBlur={() => void save({ title: draft.title })} /></label>
        <label className="notes">Description<textarea rows={5} value={draft.description || ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} onBlur={() => void save({ description: draft.description })} /></label>
        <label className="notes">Category<select value={draft.category_id || ''} onChange={(e) => void save({ category_id: e.target.value })}><option value="">Choose…</option>{(draft.suggestions || []).map((s) => <option key={s.categoryId} value={s.categoryId}>{s.categoryName}</option>)}{draft.category_id && !(draft.suggestions || []).some((s) => s.categoryId === draft.category_id) && <option value={draft.category_id}>{draft.category_name || draft.category_id}</option>}</select></label>
        <label className="notes">Condition<select value={draft.condition_id || ''} onChange={(e) => void save({ condition_id: e.target.value })}><option value="">Choose…</option>{(draft.conditions || []).map((c) => <option key={c.conditionId} value={c.conditionId}>{c.name}</option>)}</select><small>Floor condition: {draft.floor_condition || '—'}</small></label>
        <label className="notes">Condition notes<textarea rows={3} value={draft.condition_notes || ''} onChange={(e) => setDraft({ ...draft, condition_notes: e.target.value })} onBlur={() => void save({ condition_notes: draft.condition_notes })} /></label>
        <h3>Item specifics</h3>
        {(draft.aspect_defs || []).length === 0 ? <p className="hint">Pick a category to load eBay’s required and recommended specifics.</p> : (draft.aspect_defs || []).map((def) => <label className="notes" key={def.name}>{def.name}{def.required ? ' (required)' : ' (recommended)'}{def.allowed?.length ? <select value={draft.aspects?.[def.name] || ''} onChange={(e) => void save({ aspects: { [def.name]: e.target.value } })}><option value="">Choose…</option>{def.allowed.map((v) => <option key={v} value={v}>{v}</option>)}</select> : <input value={draft.aspects?.[def.name] || ''} onChange={(e) => setDraft({ ...draft, aspects: { ...draft.aspects, [def.name]: e.target.value } })} onBlur={() => void save({ aspects: { [def.name]: draft.aspects?.[def.name] || '' } })} />}</label>)}
        <h3>Box and shipping</h3>
        <BoxForm draft={draft} busy={busy} onSave={(box) => void run(async () => { const data = await call(accessToken, { action: 'save_box', sku: draft.sku, box }); setDraft(data.draft); await load(); })} />
        <p className="hint">{draft.shipping_mode === 'free' ? 'Free shipping' : draft.shipping_mode === 'calculated' ? 'Calculated shipping' : 'Shipping not set'}{draft.label_cents != null ? ` · estimated label ${money(draft.label_cents)} (${draft.label_source || 'estimate'})` : ''}</p>
        <div className="actions">
          <button className="secondary" disabled={busy} onClick={() => void save({ shipping_mode: 'free' })}>Force free shipping</button>
          <button className="secondary" disabled={busy} onClick={() => void save({ shipping_mode: 'calculated' })}>Force calculated</button>
        </div>
        <label className="notes">eBay price ($)<input value={draft.price_cents != null ? (draft.price_cents / 100).toFixed(2) : ''} onChange={(e) => setDraft({ ...draft, price_cents: Math.round(Number(e.target.value || 0) * 100) })} onBlur={() => { if (draft.price_cents) void save({ price_cents: draft.price_cents }); }} /></label>
        <h3>Ready check</h3>
        <ul className="ebay-check">{(draft.checklist || []).map((item) => <li key={item.label} className={item.ok ? 'ok-text' : 'bad-text'}>{item.ok ? 'Ready' : 'Needed'} · {item.label}</li>)}</ul>
        <div className="actions">
          <button disabled={busy || !draft.ready} onClick={() => void run(async () => { await call(accessToken, { action: 'push', skus: [draft.sku] }); setDraft(null); await load(); })}>{draft.status === 'live' ? 'Update on eBay' : 'Push to eBay'}</button>
          {draft.status === 'live' && <button className="text-button danger" disabled={busy} onClick={() => void run(async () => { await call(accessToken, { action: 'end', sku: draft.sku }); setDraft(null); await load(); })}>End listing</button>}
        </div>
      </section>}
    </div>
  </>;
}

function SettingsForm({ settings, busy, onSave }: { settings: Settings; busy: boolean; onSave: (s: Settings) => void }) {
  const [form, setForm] = useState({
    cutoff: (settings.cutoffCents / 100).toFixed(2),
    fee: String(settings.feePct),
    perOrder: (settings.perOrderCents / 100).toFixed(2),
    ending: String(settings.ending),
    zip: settings.farZip,
  });
  useEffect(() => {
    setForm({
      cutoff: (settings.cutoffCents / 100).toFixed(2),
      fee: String(settings.feePct),
      perOrder: (settings.perOrderCents / 100).toFixed(2),
      ending: String(settings.ending),
      zip: settings.farZip,
    });
  }, [settings.cutoffCents, settings.feePct, settings.perOrderCents, settings.ending, settings.farZip]);
  return <form className="number-grid" onSubmit={(e) => { e.preventDefault(); onSave({ feePct: Number(form.fee), perOrderCents: Math.round(Number(form.perOrder) * 100), cutoffCents: Math.round(Number(form.cutoff) * 100), ending: Number(form.ending), farZip: form.zip }); }}>
    <label>Free-shipping cutoff ($)<input value={form.cutoff} onChange={(e) => setForm({ ...form, cutoff: e.target.value })} /></label>
    <label>eBay fee %<input value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} /></label>
    <label>Per-order fee ($)<input value={form.perOrder} onChange={(e) => setForm({ ...form, perOrder: e.target.value })} /></label>
    <label>Price ends with<input value={form.ending} onChange={(e) => setForm({ ...form, ending: e.target.value })} /></label>
    <label>Far-zone ZIP<input value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} /></label>
    <button disabled={busy}>Save price settings</button>
  </form>;
}

function BoxForm({ draft, busy, onSave }: { draft: Draft; busy: boolean; onSave: (box: Draft['box']) => void }) {
  const [box, setBox] = useState(draft.box);
  useEffect(() => setBox(draft.box), [draft.sku, draft.box.length_in, draft.box.width_in, draft.box.height_in, draft.box.weight_lb]);
  const field = (key: keyof Draft['box'], label: string) => <label>{label}<input value={box[key] ?? ''} onChange={(e) => setBox({ ...box, [key]: e.target.value === '' ? null : Number(e.target.value) })} /></label>;
  return <form className="number-grid" onSubmit={(e) => { e.preventDefault(); onSave(box); }}>
    {field('length_in', 'Length (in)')}{field('width_in', 'Width (in)')}{field('height_in', 'Height (in)')}{field('weight_lb', 'Weight (lb)')}
    <button disabled={busy}>Save box size</button>
  </form>;
}
