import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';

type Channel = 'ebay' | 'amazon' | 'tiktok' | 'depop';
const CHANNELS: [Channel, string][] = [['ebay', 'eBay'], ['amazon', 'Amazon'], ['tiktok', 'TikTok Shop'], ['depop', 'Depop']];
type Choice = { category_id: string; path: string; required_fields: { name: string; label?: string; required?: boolean; allowed?: string[]; labels?: Record<string, string>; kind?: string }[] };
type Row = { sku: string; title: string; upc: string | null; gaps: { channel: Channel; issue: string; field?: string }[];
  channels: Record<Channel, { category_id: string | null; enabled: boolean; attributes: Record<string, string> }> | null; live: boolean };
type Props = { client: SupabaseClient; storeId: string; initialSku?: string; onSaved?: () => void };

export function CategoryPanel({ client, storeId, initialSku, onSaved }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<string[]>(initialSku ? [initialSku] : []);
  const [choices, setChoices] = useState<Partial<Record<Channel, Choice[]>>>({});
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState<Channel>('ebay');
  const [categories, setCategories] = useState<Record<Channel, string>>({ ebay: '', amazon: '', tiktok: '', depop: '' });
  const [enabled, setEnabled] = useState<Record<Channel, boolean>>({ ebay: true, amazon: true, tiktok: true, depop: false });
  const [attributes, setAttributes] = useState<Record<Channel, Record<string, string>>>({ ebay: {}, amazon: {}, tiktok: {}, depop: {} });
  const [mapping, setMapping] = useState('');
  const [internal, setInternal] = useState('');
  const [depopId, setDepopId] = useState('');
  const [depopPath, setDepopPath] = useState('');
  const [depopFields, setDepopFields] = useState('[]');
  const [depopActive, setDepopActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [offset, setOffset] = useState(0);
  const first = rows.find((row) => row.sku === selected[0]);
  const identical = useMemo(() => rows.filter((row) => row.upc && row.upc === first?.upc && !row.live), [rows, first]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error: e } = await client.rpc('portal_category_queue', { p_limit: 100, p_offset: offset });
      if (active) {
        if (e) setError(e.message);
        else setRows((data || []) as Row[]);
      }
    })();
    return () => { active = false; };
  }, [client, reload, offset]);

  useEffect(() => {
    if (!first) return;
    setCategories(Object.fromEntries(CHANNELS.map(([id]) => [id, first.channels?.[id]?.category_id || ''])) as Record<Channel, string>);
    setEnabled(Object.fromEntries(CHANNELS.map(([id]) => [id, first.channels?.[id]?.enabled ?? id !== 'depop'])) as Record<Channel, boolean>);
    setAttributes(Object.fromEntries(CHANNELS.map(([id]) => [id, first.channels?.[id]?.attributes || {}])) as Record<Channel, Record<string, string>>);
    setInternal('');
    setMapping('');
  }, [first?.sku]);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => { void (async () => {
      const { data, error: e } = await client.rpc('portal_category_search', { p_channel: channel, p_query: search, p_limit: 40 });
      if (active) {
        if (e) setError(e.message);
        else setChoices((old) => ({ ...old, [channel]: (data || []) as Choice[] }));
      }
    })(); }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [client, channel, search, reload]);

  useEffect(() => {
    const value = categories[channel];
    if (!value) return;
    let active = true;
    void (async () => {
      const query = channel === 'depop'
        ? client.from('store_depop_categories').select('category_id,path,required_fields').eq('store_id', storeId).eq('category_id', value)
        : client.from('channel_taxonomy').select('category_id,path,required_fields').eq('channel', channel).eq('category_id', value);
      const { data } = await query.maybeSingle();
      if (active && data) setChoices((old) => ({ ...old, [channel]: [data as Choice,
        ...(old[channel] || []).filter((choice) => choice.category_id !== value)] }));
    })();
    return () => { active = false; };
  }, [client, storeId, channel, categories[channel]]);

  async function pick(id: Channel, value: string) {
    setCategories((old) => ({ ...old, [id]: value }));
    if (id !== 'depop' && value) {
      const { data: session } = await client.auth.getSession();
      const token = session.session?.access_token;
      if (token) {
        const response = await fetch(floorFunctionUrl('category-fields'), { method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ store_id: storeId, channel: id, category_id: value }) });
        const result = await response.json();
        if (response.ok) setChoices((old) => ({ ...old, [id]: (old[id] || []).map((choice) =>
          choice.category_id === value ? { ...choice, required_fields: result.fields || [] } : choice) }));
        else setError(result.error || 'Could not load required category fields.');
      }
    }
    if (id !== 'ebay' || !value) return;
    const { data, error: e } = await client.from('store_category_mappings').select('*')
      .eq('store_id', storeId).eq('ebay_category_id', value).maybeSingle();
    if (e) { setError(e.message); return; }
    if (data) {
      setCategories((old) => ({ ...old, ebay: value, amazon: data.amazon_product_type || '',
        tiktok: data.tiktok_category_id || '', depop: data.depop_category_id || '' }));
      setInternal(data.internal_category || '');
      setMapping('Saved channel mapping filled.');
    } else setMapping('No mapping yet. Pick each enabled channel once, then save.');
  }

  async function save() {
    if (!selected.length) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { error: e } = await client.rpc('portal_set_channel_categories', {
        p_skus: selected, p_ebay: categories.ebay || null, p_tiktok: categories.tiktok || null,
        p_amazon: categories.amazon || null, p_depop: categories.depop || null,
        p_internal: internal || null, p_enabled: enabled,
      });
      if (e) throw e;
      for (const [id] of CHANNELS) {
        const result = await client.rpc('portal_category_attributes', { p_skus: selected, p_channel: id,
          p_attributes: attributes[id] });
        if (result.error) throw result.error;
      }
      const { data: session } = await client.auth.getSession();
      if (session.session?.access_token) {
        for (const sku of selected) {
        const response = await fetch(floorFunctionUrl('category-confirm'), { method: 'POST',
          headers: { Authorization: `Bearer ${session.session.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ store_id: storeId, sku }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not confirm the UPC category mapping.');
        if (result.cached) setNotice(`Saved ${selected.length} item${selected.length === 1 ? '' : 's'} and confirmed UPC for future scans.`);
        else setNotice(`Saved ${selected.length} item${selected.length === 1 ? '' : 's'}. UPC cache pending: ${result.reason || 'missing data'}.`);
        }
      } else setNotice(`Saved ${selected.length} item${selected.length === 1 ? '' : 's'}.`);
      setReload((n) => n + 1);
      onSaved?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }

  async function saveDepop() {
    setBusy(true); setError('');
    let required: unknown;
    try { required = JSON.parse(depopFields); if (!Array.isArray(required)) throw new Error('Expected a list.'); }
    catch { setError('Required fields must be a JSON list, such as [{"name":"Size","allowed":["S","M"]}].'); setBusy(false); return; }
    const { error: e } = await client.rpc('portal_depop_category_save', { p_id: depopId, p_path: depopPath,
      p_required: required, p_active: depopActive });
    if (e) setError(e.message);
    else { setDepopId(''); setDepopPath(''); setNotice('Depop category saved.'); setReload((n) => n + 1); }
    setBusy(false);
  }

  const activeChoice = choices[channel]?.find((item) => item.category_id === categories[channel]);
  return <section className="panel category-panel">
    <h2>Missing Category</h2>
    <p className="hint">Choose a real category for each enabled channel. Required fields appear after you select a category.</p>
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p className="hint" role="status">{notice}</p>}
    <div className="category-layout">
      <div className="category-queue">
        <strong>Items needing categories or fields</strong>
        {rows.map((row) => <button className={`category-row ${selected.includes(row.sku) ? 'active' : ''}`} type="button" key={row.sku}
          onClick={() => setSelected([row.sku])}>
          <span><b>{row.title || `SKU ${row.sku}`}</b><small>SKU {row.sku}{row.upc ? ` · UPC ${row.upc}` : ''}{row.live ? ' · Live online' : ''}</small></span>
          <small>{row.gaps.map((gap) => `${gap.channel}: ${gap.issue}${gap.field ? ` (${gap.field})` : ''}`).join(' · ')}</small>
        </button>)}
        {!rows.length && <p className="hint">No items in the current page need category work.</p>}
        <div className="category-channel-list"><button type="button" className="secondary" disabled={offset===0} onClick={() => setOffset(Math.max(0,offset-100))}>Previous</button>
          <button type="button" className="secondary" disabled={rows.length<100} onClick={() => setOffset(offset+100)}>Next</button></div>
        {first?.upc && <button type="button" className="secondary" onClick={() => { void client.rpc('portal_identical_category_skus', { p_sku: first.sku })
          .then(({ data, error: e }) => { if (e) setError(e.message); else setSelected((data || []) as string[]); }); }}>
          Select identical UPC items{identical.length > 1 ? ` (${identical.length} on this page)` : ''}</button>}
      </div>
      <div className="category-editor">
        <strong>{first ? `Assign SKU ${first.sku}${selected.length > 1 ? ` and ${selected.length - 1} more` : ''}` : 'Select an item'}</strong>
        {first && <>
          <div className="category-channel-list">{CHANNELS.map(([id, label]) => <label key={id}><input type="checkbox" checked={enabled[id]}
            onChange={(e) => setEnabled((old) => ({ ...old, [id]: e.target.checked }))} /> {label}</label>)}</div>
          <div className="category-channel-list">{CHANNELS.map(([id, label]) => <button type="button" key={id}
            className={channel === id ? 'active' : 'secondary'} onClick={() => { setChannel(id); setSearch(''); }}>{label}</button>)}</div>
          <label>Search {CHANNELS.find(([id]) => id === channel)?.[1]} categories<input type="search" value={search}
            onChange={(e) => setSearch(e.target.value)} placeholder="Type part of a category path" /></label>
          <div className="category-results">{(choices[channel] || []).map((choice) => <button type="button" key={choice.category_id}
            className={categories[channel] === choice.category_id ? 'active' : ''} onClick={() => void pick(channel, choice.category_id)}>
            {choice.path}<small>{choice.category_id}</small></button>)}</div>
          {categories[channel] && <p className="hint">Selected: {activeChoice?.path || categories[channel]}</p>}
          {mapping && <p className="hint">{mapping}</p>}
          {(activeChoice?.required_fields || []).filter((field) => field.required !== false
            || Boolean(attributes[channel][field.name])
            || first?.gaps.some((gap) => gap.channel === channel && gap.field === field.name)).map((field) => field.kind === 'unsupported_document'
            ? <p className="hint" key={field.name}>{field.label || field.name} requires channel approval or a document upload before listing.</p>
            : <label key={field.name}>{field.label || field.name}
            {field.allowed?.length ? <select value={attributes[channel][field.name] || ''} onChange={(e) => setAttributes((old) => ({ ...old,
              [channel]: { ...old[channel], [field.name]: e.target.value } }))}>
              <option value="">Choose…</option>{field.allowed.map((value) => <option key={value} value={value}>{field.labels?.[value] || value}</option>)}
            </select> : field.kind === 'json' ? <textarea rows={3} value={attributes[channel][field.name] || ''}
              onChange={(e) => setAttributes((old) => ({ ...old, [channel]: { ...old[channel], [field.name]: e.target.value } }))} />
              : <input value={attributes[channel][field.name] || ''} onChange={(e) => setAttributes((old) => ({ ...old,
              [channel]: { ...old[channel], [field.name]: e.target.value } }))} />}</label>)}
          <label>Floor category<input value={internal} onChange={(e) => setInternal(e.target.value)} /></label>
          <button type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save categories and fields'}</button>
        </>}
        <details><summary>Maintain Depop categories</summary>
          <label>Category ID<input value={depopId} onChange={(e) => setDepopId(e.target.value)} /></label>
          <label>Full path<input value={depopPath} onChange={(e) => setDepopPath(e.target.value)} /></label>
          <label>Required fields (JSON list)<textarea rows={3} value={depopFields} onChange={(e) => setDepopFields(e.target.value)} /></label>
          <label><input type="checkbox" checked={depopActive} onChange={(e) => setDepopActive(e.target.checked)} /> Active</label>
          <button type="button" disabled={busy || !depopId.trim() || !depopPath.trim()} onClick={() => void saveDepop()}>Save Depop category</button>
        </details>
      </div>
    </div>
  </section>;
}
