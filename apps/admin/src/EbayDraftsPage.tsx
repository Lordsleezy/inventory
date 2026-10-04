import { useCallback, useEffect, useRef, useState } from 'react';

const functionsBase = (import.meta.env.VITE_FLOOR_FUNCTIONS_URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');

type Fail = string;
type Summary = {
  sku: string; title: string | null; status: string; ready: boolean; price_cents: number | null;
  shipping_mode: string | null; label_cents: number | null; shipping_buffer_cents: number; label_source: string | null;
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
  floor_condition: string; floor_cents: number | null; dims_source: string | null;
  quotes: { free: number; calculated: number } | null;
  market: { kind: string; cents: number | null; store?: string; count?: number } | null;
  market_needs_refresh: boolean;
  checklist: { ok: boolean; label: string }[]; locks: string[];
};
type Backfill = { status?: string; processed?: number; total?: number; searched?: number; cost_usd?: number; note?: string };
type Settings = { feePct: number; perOrderCents: number; cutoffCents: number; bufferCents: number; ending: number; farZip: string };
type Props = { accessToken: string; userId: string; money: (n: number) => string; active: boolean };

const editorKey = (userId: string, sku: string) => `floor-admin-ebay-editor:${userId}:${sku}`;
function cachedEditor(userId: string, sku: string | null): { draft: Draft; dirty: string[] } | null {
  if (!sku) return null;
  try {
    const value = JSON.parse(localStorage.getItem(editorKey(userId, sku)) || 'null');
    return value?.draft?.sku === sku && Array.isArray(value.dirty) ? value : null;
  } catch { return null; }
}

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

export function EbayDraftsPage({ accessToken, userId, money, active }: Props) {
  const draftKey = `floor-admin-ebay-draft:${userId}`;
  const initialSku = sessionStorage.getItem(draftKey) ?? localStorage.getItem(draftKey);
  const initialEditor = useRef(cachedEditor(userId, initialSku));
  const [rows, setRows] = useState<Summary[] | null>(null);
  const [counts, setCounts] = useState({ total: 0, ready: 0, needsBox: 0, live: 0 });
  const [connected, setConnected] = useState<boolean | null>(null);
  const [policies, setPolicies] = useState<{ ok?: boolean; missing?: string[] } | null>(null);
  const [settings, setSettings] = useState<Settings>({ feePct: 13.25, perOrderCents: 40, cutoffCents: 1500, bufferCents: 200, ending: 99, farZip: '10001' });
  const [draft, setDraft] = useState<Draft | null>(initialEditor.current?.draft || null);
  const draftRef = useRef<Draft | null>(initialEditor.current?.draft || null);
  const dirtyRef = useRef(new Set(initialEditor.current?.dirty || []));
  const [picked, setPicked] = useState<string[]>([]);
  const [backfill, setBackfill] = useState<Backfill | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openingSku, setOpeningSku] = useState<string | null>(null);
  const marketInFlight = useRef(new Set<string>());
  const restoreAttempt = useRef<string | null>(null);
  const openSequence = useRef(0);

  function persistEditor(next: Draft) {
    if (dirtyRef.current.size) localStorage.setItem(editorKey(userId, next.sku), JSON.stringify({ draft: next, dirty: [...dirtyRef.current] }));
    else localStorage.removeItem(editorKey(userId, next.sku));
  }

  function editDraft(field: 'title' | 'description' | 'condition_notes' | 'aspects', next: Draft) {
    dirtyRef.current.add(field);
    draftRef.current = next;
    setDraft(next);
    persistEditor(next);
  }

  function showDraft(next: Draft | null) {
    if (next) {
      const cached = cachedEditor(userId, next.sku);
      const local = draftRef.current?.sku === next.sku ? draftRef.current : cached?.draft;
      const dirty = draftRef.current?.sku === next.sku ? dirtyRef.current : new Set(cached?.dirty || []);
      next = { ...next };
      for (const field of dirty) if (local && field in local) (next as unknown as Record<string, unknown>)[field] = (local as unknown as Record<string, unknown>)[field];
      dirtyRef.current = dirty;
      draftRef.current = next;
      persistEditor(next);
    } else {
      openSequence.current += 1;
      dirtyRef.current.clear();
      draftRef.current = null;
    }
    setDraft(next);
    if (next) { sessionStorage.setItem(draftKey, next.sku); localStorage.setItem(draftKey, next.sku); }
    else { sessionStorage.removeItem(draftKey); localStorage.removeItem(draftKey); }
    if (next && next.market_needs_refresh && !marketInFlight.current.has(next.sku)) {
      marketInFlight.current.add(next.sku);
      void call(accessToken, { action: 'market', sku: next.sku })
        .then((data) => setDraft((current) => current?.sku === next.sku ? { ...current, market: data.market, market_needs_refresh: false } : current))
        .catch(() => undefined)
        .finally(() => marketInFlight.current.delete(next.sku));
    }
  }

  function acceptSaved(next: Draft, fields: Record<string, unknown>) {
    const current = draftRef.current as unknown as Record<string, unknown> | null;
    for (const [field, value] of Object.entries(fields)) {
      if (current && JSON.stringify(current[field]) === JSON.stringify(value)) dirtyRef.current.delete(field);
    }
    showDraft(next);
  }

  useEffect(() => { draftRef.current = draft; if (draft) persistEditor(draft); }, [draft, userId]);

  useEffect(() => {
    const sku = sessionStorage.getItem(draftKey) ?? localStorage.getItem(draftKey);
    const attempt = `${sku}:${accessToken}`;
    if (!sku || restoreAttempt.current === attempt) return;
    restoreAttempt.current = attempt;
    void call(accessToken, { action: 'prepare', sku })
      .then((data) => { if ((sessionStorage.getItem(draftKey) ?? localStorage.getItem(draftKey)) === sku) showDraft(data.draft); })
      .catch((e) => setError(`Could not reopen SKU ${sku}: ${e.message}`));
  }, [accessToken, draftKey]);

  const load = useCallback(async (refresh = false) => {
    const data = await call(accessToken, { action: refresh ? 'refresh' : 'list' });
    setRows(data.drafts || []);
    setCounts(data.counts || { total: 0, ready: 0, needsBox: 0, live: 0 });
    setConnected(Boolean(data.connected));
    setPolicies(data.policies);
    if (data.settings) setSettings(data.settings);
    if (data.backfill) setBackfill(data.backfill);
  }, [accessToken]);

  useEffect(() => { if (!active) return; void load().catch((e) => setError(e.message)); const timer = setInterval(() => { void load().catch(() => undefined); }, 60_000); return () => clearInterval(timer); }, [active, load]);
  useEffect(() => { if (!rows) return; setCounts({ total: rows.length, ready: rows.filter((row) => row.ready && row.status !== 'live').length, needsBox: rows.filter((row) => row.fails.includes('Needs box size')).length, live: rows.filter((row) => row.status === 'live').length }); }, [rows]);
  useEffect(() => {
    if (backfill?.status !== 'running') return undefined;
    const timer = setInterval(() => {
      void call(accessToken, { action: 'backfill_status' }).then((data) => setBackfill(data.backfill)).catch(() => undefined);
    }, 8000);
    return () => clearInterval(timer);
  }, [accessToken, backfill?.status]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function open(sku: string) {
    const sequence = ++openSequence.current;
    sessionStorage.setItem(draftKey, sku);
    localStorage.setItem(draftKey, sku);
    const cached = cachedEditor(userId, sku);
    if (cached) showDraft(cached.draft);
    else setOpeningSku(sku);
    await run(async () => { const data = await call(accessToken, { action: 'prepare', sku }); if (sequence === openSequence.current) showDraft(data.draft); });
    if (sequence === openSequence.current) setOpeningSku(null);
  }
  async function save(fields: Record<string, unknown>) {
    if (!draft) return;
    const sku = draft.sku;
    await run(async () => { const data = await call(accessToken, { action: 'save', sku, fields }); if (draftRef.current?.sku === sku) acceptSaved(data.draft, fields); setRows((current) => current?.map((row) => row.sku === data.draft.sku ? { ...row, ...data.draft } : row) || current); });
  }
  function toggle(sku: string) {
    setPicked((cur) => cur.includes(sku) ? cur.filter((s) => s !== sku) : [...cur, sku]);
  }

  return <>
    <header><div><div className="eyebrow">EBAY</div><h1>eBay drafts</h1>
      <p>Drafts stay in Floor until you push them. New eligible units appear on their own. Sold, delisted, and ineligible units drop off.</p></div>
      <div className="actions">
        <button className="secondary" disabled={busy} onClick={() => void run(() => load(true))}>Refresh</button>
        <button disabled={busy || picked.length === 0} onClick={() => void run(async () => {
          const data = await call(accessToken, { action: 'push', skus: picked });
          const failed = (data.results || []).filter((r: { ok: boolean; sku: string; error?: string }) => !r.ok);
          const succeeded = (data.results || []).filter((r: { ok: boolean; sku: string }) => r.ok);
          for (const result of succeeded) localStorage.removeItem(editorKey(userId, result.sku));
          setPicked(failed.map((r: { sku: string }) => r.sku));
          if (draft && succeeded.some((r: { sku: string }) => r.sku === draft.sku)) showDraft(null);
          await load();
          if (failed.length) setError(failed.map((r: { sku: string; error?: string }) => `SKU ${r.sku}: ${r.error}`).join(' '));
        })}>Push selected</button>
      </div></header>
    {error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    <div className="stats"><div className="stat"><span>Drafts</span><strong>{counts.total}</strong></div><div className="stat"><span>Ready to push</span><strong>{counts.ready}</strong></div><div className="stat"><span>Need box size</span><strong>{counts.needsBox}</strong></div><div className="stat"><span>Live</span><strong>{counts.live}</strong></div></div>
    {backfill?.status === 'running' && <p className="notice">Backfilling specs: {backfill.processed || 0}/{backfill.total || 0}</p>}
    {backfill?.status === 'paused' && backfill.note && <p className="hint">Spec backfill paused: {backfill.note}</p>}

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

      {openingSku && <section className="panel ebay-editor" role="status">Opening SKU {openingSku}…</section>}
      {draft && !openingSku && <section className="panel ebay-editor"><div className="section-head"><h2>SKU {draft.sku}</h2><div className="actions">{dirtyRef.current.size > 0 && <button disabled={busy} onClick={() => void save(Object.fromEntries([...dirtyRef.current].map((field) => [field, (draft as unknown as Record<string, unknown>)[field]])))}>Save changes</button>}<button className="text-button" onClick={() => showDraft(null)}>Close</button></div></div>
        {dirtyRef.current.size > 0 && <p className="hint">Unsaved edits are kept in this browser until you save them.</p>}
        {draft.status === 'live' && draft.view_url && <p><b className="tag on">Live</b> <a href={draft.view_url} target="_blank" rel="noreferrer">Open on eBay</a></p>}
        {draft.ebay_error && <div className="alert" role="alert">{draft.ebay_error}</div>}
        <div className="ebay-photos">{draft.photos.map((photo, i) => <figure key={photo.path}><img src={photo.url} alt="" />{i === 0 && <figcaption>Main</figcaption>}<div className="actions"><button className="secondary" disabled={i === 0 || busy} onClick={() => { const photos = [...draft.photos]; const [moved] = photos.splice(i, 1); photos.unshift(moved); void save({ photo_paths: photos.map((p) => p.path) }); }}>Make main</button>{i > 0 && <button className="secondary" disabled={busy} onClick={() => { const photos = [...draft.photos]; [photos[i - 1], photos[i]] = [photos[i], photos[i - 1]]; void save({ photo_paths: photos.map((p) => p.path) }); }}>Left</button>}</div></figure>)}</div>
        <label className="notes">Title<input value={draft.title || ''} maxLength={80} onChange={(e) => editDraft('title', { ...draft, title: e.target.value })} onBlur={() => void save({ title: draft.title })} /></label>
        <label className="notes">Description<textarea rows={5} value={draft.description || ''} onChange={(e) => editDraft('description', { ...draft, description: e.target.value })} onBlur={() => void save({ description: draft.description })} /></label>
        <label className="notes">Category<select value={draft.category_id || ''} onChange={(e) => void save({ category_id: e.target.value })}><option value="">Choose…</option>{(draft.suggestions || []).map((s) => <option key={s.categoryId} value={s.categoryId}>{s.categoryName}</option>)}{draft.category_id && !(draft.suggestions || []).some((s) => s.categoryId === draft.category_id) && <option value={draft.category_id}>{draft.category_name || draft.category_id}</option>}</select></label>
        <label className="notes">Condition<select value={draft.condition_id || ''} onChange={(e) => void save({ condition_id: e.target.value })}><option value="">Choose…</option>{(draft.conditions || []).map((c) => <option key={c.conditionId} value={c.conditionId}>{c.name}</option>)}</select><small>Floor condition: {draft.floor_condition || '—'}</small></label>
        <label className="notes">Condition notes<textarea rows={3} value={draft.condition_notes || ''} onChange={(e) => editDraft('condition_notes', { ...draft, condition_notes: e.target.value })} onBlur={() => void save({ condition_notes: draft.condition_notes })} /></label>
        <h3>Item specifics</h3>
        {(draft.aspect_defs || []).length === 0 ? <p className="hint">Pick a category to load eBay’s required and recommended specifics.</p> : (draft.aspect_defs || []).map((def) => <AspectField key={def.name} def={def} value={draft.aspects?.[def.name] || ''} disabled={busy} onChange={(value) => editDraft('aspects', { ...draft, aspects: { ...draft.aspects, [def.name]: value } })} onCommit={(value) => void save({ aspects: { ...draft.aspects, [def.name]: value } })} />)}
        <h3>Box and shipping</h3>
        <BoxForm draft={draft} userId={userId} busy={busy} onSave={(box) => void run(async () => { const data = await call(accessToken, { action: 'save_box', sku: draft.sku, box }); if (draftRef.current?.sku === data.draft.sku) showDraft(data.draft); setRows((current) => current?.map((row) => row.sku === data.draft.sku ? { ...row, ...data.draft } : row) || current); })} />
        <ShippingMath draft={draft} userId={userId} settings={settings} money={money} busy={busy} onMode={(mode) => void save({ shipping_mode: mode })} onPrice={(cents) => void save({ price_cents: cents })} />
        <h3>Ready check</h3>
        <ul className="ebay-check">{(draft.checklist || []).map((item) => <li key={item.label} className={item.ok ? 'ok-text' : 'bad-text'}>{item.ok ? 'Ready' : 'Needed'} · {item.label}</li>)}</ul>
        <div className="actions">
          <button disabled={busy || !draft.ready} onClick={() => void run(async () => { const data = await call(accessToken, { action: 'push', skus: [draft.sku] }); const result = data.results?.[0]; if (!result?.ok) throw new Error(result?.error || 'eBay did not accept this listing.'); localStorage.removeItem(editorKey(userId, draft.sku)); showDraft(null); await load(); })}>{draft.status === 'live' ? 'Update on eBay' : 'Push to eBay'}</button>
          {draft.status === 'live' && <button className="text-button danger" disabled={busy} onClick={() => void run(async () => { await call(accessToken, { action: 'end', sku: draft.sku }); showDraft(null); await load(); })}>End listing</button>}
        </div>
      </section>}
    </div>
  </>;
}

function SettingsForm({ settings, busy, onSave }: { settings: Settings; busy: boolean; onSave: (s: Settings) => void }) {
  const [form, setForm] = useState({
    cutoff: (settings.cutoffCents / 100).toFixed(2),
    buffer: (settings.bufferCents / 100).toFixed(2),
    fee: String(settings.feePct),
    perOrder: (settings.perOrderCents / 100).toFixed(2),
    ending: String(settings.ending),
    zip: settings.farZip,
  });
  useEffect(() => {
    setForm({
      cutoff: (settings.cutoffCents / 100).toFixed(2),
      buffer: (settings.bufferCents / 100).toFixed(2),
      fee: String(settings.feePct),
      perOrder: (settings.perOrderCents / 100).toFixed(2),
      ending: String(settings.ending),
      zip: settings.farZip,
    });
  }, [settings.cutoffCents, settings.bufferCents, settings.feePct, settings.perOrderCents, settings.ending, settings.farZip]);
  return <form className="number-grid" onSubmit={(e) => { e.preventDefault(); onSave({ feePct: Number(form.fee), perOrderCents: Math.round(Number(form.perOrder) * 100), cutoffCents: Math.round(Number(form.cutoff) * 100), bufferCents: Math.round(Number(form.buffer) * 100), ending: Number(form.ending), farZip: form.zip }); }}>
    <label>Free-shipping cutoff ($)<input value={form.cutoff} onChange={(e) => setForm({ ...form, cutoff: e.target.value })} /></label>
    <label>Shipping buffer ($)<input inputMode="decimal" value={form.buffer} onChange={(e) => { if (/^\d*(?:\.\d{0,2})?$/.test(e.target.value)) setForm({ ...form, buffer: e.target.value }); }} onBlur={() => setForm((current) => ({ ...current, buffer: Number(current.buffer || 0).toFixed(2) }))} /></label>
    <label>eBay fee %<input value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} /></label>
    <label>Per-order fee ($)<input value={form.perOrder} onChange={(e) => setForm({ ...form, perOrder: e.target.value })} /></label>
    <label>Price ends with<input value={form.ending} onChange={(e) => setForm({ ...form, ending: e.target.value })} /></label>
    <label>Far-zone ZIP<input value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} /></label>
    <button disabled={busy}>Save price settings</button>
  </form>;
}

function MarketLine({ market, money }: { market: Draft['market']; money: (n: number) => string }) {
  if (market?.cents) {
    return <p className="hint">{market.kind === 'sold'
      ? `Sells online around ${money(market.cents)} (average of ${market.count || 1} sale${market.count === 1 ? '' : 's'})`
      : `Highest retail ${money(market.cents)}${market.store ? ` at ${market.store}` : ''}`}</p>;
  }
  if (market?.kind === 'none') return <p className="hint">No current selling price found.</p>;
  return null;
}

function PriceField({ sku, userId, cents, disabled, onCommit }: { sku: string; userId: string; cents: number | null; disabled: boolean; onCommit: (cents: number) => void }) {
  const key = `floor-admin-ebay-price:${userId}:${sku}`;
  const formatted = cents != null ? (cents / 100).toFixed(2) : '';
  const [text, setText] = useState(() => localStorage.getItem(key) ?? formatted);
  useEffect(() => {
    const pending = localStorage.getItem(key);
    if (pending != null && Math.round(Number(pending) * 100) === cents) localStorage.removeItem(key);
    setText(localStorage.getItem(key) ?? formatted);
  }, [key, cents]);
  return <label className="notes">eBay price ($)<input inputMode="decimal" value={text} disabled={disabled} onChange={(e) => { if (/^\d*(?:\.\d{0,2})?$/.test(e.target.value)) { setText(e.target.value); localStorage.setItem(key, e.target.value); } }} onBlur={() => { const next = Math.round(Number(text || 0) * 100); if (next > 0 && next !== cents) onCommit(next); else if (next === cents) localStorage.removeItem(key); }} /></label>;
}

function boxReady(box: Draft['box']) {
  return [box.length_in, box.width_in, box.height_in, box.weight_lb].every((n) => Number(n) > 0);
}

function allowsCustom(def: Aspect) {
  const name = def.name.toLowerCase();
  if (name === 'brand') return true;
  if (/height|width|length|depth|weight|flow rate|working pressure|\bpressure\b|\bvolume\b/.test(name)) return true;
  return !def.selectionOnly;
}

function AspectField({ def, value, disabled, onChange, onCommit }: { def: Aspect; value: string; disabled: boolean; onChange: (value: string) => void; onCommit: (value: string) => void }) {
  const custom = allowsCustom(def);
  const options = def.allowed || [];
  const long = options.length > 30 || def.name.toLowerCase() === 'brand';
  const label = `${def.name}${def.required ? ' (required)' : ' (recommended)'}`;
  if (!custom && !long) {
    return <label className="notes">{label}<select value={options.includes(value) ? value : ''} disabled={disabled} onChange={(e) => onCommit(e.target.value)}><option value="">Choose…</option>{options.map((v) => <option key={v} value={v}>{v}</option>)}</select></label>;
  }
  if (!custom) {
    return <label className="notes">{label}<SearchList options={options} value={value} disabled={disabled} allowCustom={false} onChange={onChange} onCommit={onCommit} /></label>;
  }
  if (long) {
    return <label className="notes">{label}<SearchList options={options} value={value} disabled={disabled} allowCustom onChange={onChange} onCommit={onCommit} /></label>;
  }
  const listId = `aspect-${def.name.replace(/[^a-z0-9]+/gi, '-')}`;
  return <label className="notes">{label}<input value={value} disabled={disabled} list={options.length ? listId : undefined} onChange={(e) => onChange(e.target.value)} onBlur={() => onCommit(value)} />{options.length > 0 && <datalist id={listId}>{options.map((v) => <option key={v} value={v} />)}</datalist>}</label>;
}

function SearchList({ options, value, disabled, allowCustom, onChange, onCommit }: { options: string[]; value: string; disabled: boolean; allowCustom: boolean; onChange: (value: string) => void; onCommit: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const picked = useRef(false);
  const query = value.trim().toLowerCase();
  const matches = options.filter((option) => option.toLowerCase().includes(query)).slice(0, 12);
  return <span className="ebay-combo"><input value={value} disabled={disabled} placeholder={allowCustom ? 'Type to search or enter your own' : 'Type to search'} onFocus={() => setOpen(true)} onChange={(e) => { onChange(e.target.value); setOpen(true); }} onBlur={() => { setOpen(false); if (picked.current) { picked.current = false; return; } const exact = options.find((option) => option.toLowerCase() === value.trim().toLowerCase()); if (exact) onCommit(exact); else if (allowCustom) onCommit(value.trim()); else onCommit(options.includes(value) ? value : ''); }} />{open && matches.length > 0 && <ul>{matches.map((option) => <li key={option}><button type="button" onMouseDown={(e) => { e.preventDefault(); picked.current = true; onChange(option); onCommit(option); setOpen(false); }}>{option}</button></li>)}</ul>}</span>;
}

function ShippingMath({ draft, userId, settings, money, busy, onMode, onPrice }: { draft: Draft; userId: string; settings: Settings; money: (n: number) => string; busy: boolean; onMode: (mode: 'free' | 'calculated') => void; onPrice: (cents: number) => void }) {
  const ready = boxReady(draft.box);
  const label = draft.label_cents;
  const forced = (draft.locks || []).includes('shipping');
  const source = draft.label_source === 'shippo' ? 'Shippo quote' : draft.label_source === 'fallback' ? 'fallback table' : 'estimate';
  const over = label != null && label > settings.cutoffCents;
  const why = !ready || label == null
    ? 'Enter box size to get shipping and price.'
    : `${money(label)} from the ${source} to ${settings.farZip}, ${over ? `over ${money(settings.cutoffCents)}, so calculated shipping` : `at or under ${money(settings.cutoffCents)}, so free shipping`}.`;
  return <>
    {draft.dims_source === 'estimated' && <p className="hint">Estimated, check before shipping.</p>}
    <p className="hint">{forced && ready ? `You chose ${draft.shipping_mode === 'free' ? 'free' : 'calculated'} shipping. Suggested: ${why}` : why}</p>
    {ready && label != null && draft.floor_cents != null && <ul className="ebay-check">
      <li>Floor price {money(draft.floor_cents)}</li>
      <li>Label {money(label)} ({source}){draft.shipping_mode === 'free' ? ', baked into the price' : ', buyer pays shipping'}</li>
      <li>Shipping buffer {money(draft.shipping_mode === 'free' ? draft.shipping_buffer_cents : 0)}{draft.shipping_mode === 'free' ? ', baked into the price' : ', not applied'}</li>
      <li>eBay fee {settings.feePct}% plus {money(settings.perOrderCents)} per order</li>
      <li>eBay price {draft.price_cents != null ? money(draft.price_cents) : '—'}</li>
    </ul>}
    <div className="actions">
      <button className="secondary" disabled={busy || !draft.quotes} onClick={() => onMode('free')}>Force free shipping{draft.quotes ? ` · ${money(draft.quotes.free)} (includes ${money(settings.bufferCents)} buffer)` : ''}</button>
      <button className="secondary" disabled={busy || !draft.quotes} onClick={() => onMode('calculated')}>Force calculated{draft.quotes ? ` · ${money(draft.quotes.calculated)} ($0 buffer)` : ''}</button>
    </div>
    <MarketLine market={draft.market} money={money} />
    <PriceField sku={draft.sku} userId={userId} cents={draft.price_cents} disabled={busy} onCommit={onPrice} />
  </>;
}

function BoxForm({ draft, userId, busy, onSave }: { draft: Draft; userId: string; busy: boolean; onSave: (box: Draft['box']) => void }) {
  const key = `floor-admin-ebay-box:${userId}:${draft.sku}`;
  const fields = ['length_in', 'width_in', 'height_in', 'weight_lb'] as const;
  const fromDraft = () => Object.fromEntries(fields.map((field) => [field, draft.box[field] == null ? '' : String(draft.box[field])])) as Record<typeof fields[number], string>;
  const pending = () => { try { return JSON.parse(localStorage.getItem(key) || 'null') as Record<typeof fields[number], string> | null; } catch { return null; } };
  const [box, setBox] = useState(() => pending() || fromDraft());
  useEffect(() => {
    const local = pending();
    if (local && fields.every((field) => Number(local[field] || 0) === Number(draft.box[field] || 0))) localStorage.removeItem(key);
    setBox(pending() || fromDraft());
  }, [key, draft.box.length_in, draft.box.width_in, draft.box.height_in, draft.box.weight_lb]);
  const field = (fieldKey: typeof fields[number], label: string) => <label>{label}<input inputMode="decimal" value={box[fieldKey]} onChange={(e) => { if (!/^\d*(?:\.\d*)?$/.test(e.target.value)) return; const next = { ...box, [fieldKey]: e.target.value }; setBox(next); localStorage.setItem(key, JSON.stringify(next)); }} /></label>;
  return <form className="number-grid" onSubmit={(e) => { e.preventDefault(); onSave(Object.fromEntries(fields.map((field) => [field, box[field] ? Number(box[field]) : null])) as Draft['box']); }}>
    {field('length_in', 'Length (in)')}{field('width_in', 'Width (in)')}{field('height_in', 'Height (in)')}{field('weight_lb', 'Weight (lb)')}
    <button disabled={busy}>Save box size</button>
  </form>;
}
