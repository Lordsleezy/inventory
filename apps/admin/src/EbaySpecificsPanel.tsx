import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';

type Field = { name: string; required?: boolean; recommended?: boolean; allowed?: string[]; selection_only?: boolean };
type Form = { sku: string; upc: string | null; enabled: boolean; category_id: string | null; path: string | null;
  suggestion: { category_id: string; path: string } | null; fields: Field[]; attributes: Record<string, string>; missing: string[];
  item?: { title?: string; brand?: string; model?: string; condition?: string; description?: string; defect_notes?: string } };
type Choice = { category_id: string; path: string };
type Props = { client: SupabaseClient; sku: string; storeId?: string; appMode?: boolean; onSaved?: () => void;
  /** Item edit passes its Description box so a generated description lands in the form that Save changes writes. */
  onDescription?: (text: string) => void;
  /** Item edit calls this before its own Save so unsaved specifics / generated text are never lost. */
  persistRef?: { current: (() => Promise<void>) | null } };

/** eBay item specifics: required first, eBay's allowed values as searchable lists. No AI. */
export function EbaySpecificsPanel({ client, sku, storeId, appMode = false, onSaved, onDescription, persistRef }: Props) {
  const [form, setForm] = useState<Form | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [canPick, setCanPick] = useState(false);
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<Choice[]>([]);
  const [picked, setPicked] = useState<Choice | null>(null);
  const [applyingSuggested, setApplyingSuggested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [generatedDescription, setGeneratedDescription] = useState('');
  const [useGeneratedDescription, setUseGeneratedDescription] = useState(false);
  const [savedDescription, setSavedDescription] = useState('');

  async function call(action: string, extra: Record<string, unknown> = {}) {
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('Sign in again.');
    const response = await fetch(floorFunctionUrl('ebay-specifics'), { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_id: storeId, sku, action, ...extra }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'eBay specifics unavailable.');
    return result as { form: Form; remembered?: boolean };
  }

  function show(next: Form) {
    setForm(next);
    setValues(next.attributes || {});
    setPicked(next.category_id ? null : next.suggestion);
    setApplyingSuggested(false);
    setUseGeneratedDescription(false);
    setSavedDescription('');
    setGeneratedDescription(next.item?.description?.trim() ? '' : makeDescription(next.item, sku));
  }

  useEffect(() => {
    let active = true;
    setError(''); setNotice('');
    void client.rpc('portal_unit_ebay_specifics', { p_sku: sku }).then(({ data }) => {
      if (active) setCanPick(Boolean((data as { can_pick_category?: boolean } | null)?.can_pick_category));
    });
    void call('autofill').then((r) => { if (active) show(r.form); })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [client, sku]);

  useEffect(() => {
    if (!canPick || !query.trim()) { setChoices([]); return; }
    let active = true;
    const timer = setTimeout(() => {
      void client.rpc('portal_category_search', { p_channel: 'ebay', p_query: query.trim(), p_limit: 30 })
        .then(({ data, error: e }) => { if (active) { if (e) setError(e.message); else setChoices((data || []) as Choice[]); } });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [client, canPick, query]);

  const required = useMemo(() => (form?.fields || []).filter((f) => f.required), [form]);
  const optional = useMemo(() => (form?.fields || []).filter((f) => !f.required && f.recommended), [form]);
  const missing = required.filter((f) => !values[f.name]?.trim()
    || (f.selection_only && f.allowed?.length && !f.allowed.includes(values[f.name].trim())));

  async function useCategory(choice: Choice) {
    setBusy(true); setError('');
    try {
      const { data } = await client.auth.getSession();
      const token = data.session?.access_token;
      if (token) await fetch(floorFunctionUrl('category-fields'), { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_id: storeId, channel: 'ebay', category_id: choice.category_id }) });
      const { error: e } = await client.rpc('portal_set_unit_ebay_category', { p_sku: sku, p_category_id: choice.category_id });
      if (e) throw e;
      const r = await call('autofill');
      show(r.form);
      const mapped = await call('category-selected');
      show(mapped.form);
      setQuery('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function toggleSuggestedCategory(checked: boolean) {
    if (!checked || !picked) { setApplyingSuggested(false); return; }
    setApplyingSuggested(true);
    void useCategory(picked).finally(() => setApplyingSuggested(false));
  }

  /** Save the description on the item, then copy it to the live eBay listing (description only). */
  async function persistDescription(text: string) {
    const value = text.trim();
    if (!value || value === savedDescription) return;
    const { error: descriptionError } = await client.rpc('portal_set_unit_text', { p_sku: sku, p_field: 'description', p_value: value });
    if (descriptionError) throw descriptionError;
    setSavedDescription(value);
    onDescription?.(value);
    try { await call('sync-description'); }
    catch (e) { setNotice(`Description saved. The eBay listing was not updated: ${e instanceof Error ? e.message : String(e)}`); }
  }

  /** Everything unsaved in this panel (changed specifics, ticked description). */
  async function persist() {
    if (!form) return;
    const changed = Object.fromEntries((form.fields || []).map((f) => [f.name, values[f.name] ?? ''])
      .filter(([name, value]) => (form.attributes[name] ?? '') !== value));
    if (Object.keys(changed).length) {
      const { error: e } = await client.rpc('portal_set_unit_ebay_specifics', { p_sku: sku, p_attributes: changed });
      if (e) throw e;
      setForm({ ...form, attributes: { ...form.attributes, ...changed } });
    }
    if (useGeneratedDescription && canPick) await persistDescription(generatedDescription);
  }
  if (persistRef) persistRef.current = persist;

  async function toggleGenerated(on: boolean) {
    setUseGeneratedDescription(on);
    if (!on) return;
    onDescription?.(generatedDescription);
    if (!canPick) return; // clerks: the text goes into the Description box and saves with Save changes
    setBusy(true); setError('');
    try { await persistDescription(generatedDescription); setNotice('Description saved on the item.'); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!form) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const changed = Object.fromEntries((form.fields || []).map((f) => [f.name, values[f.name] ?? ''])
        .filter(([name, value]) => (form.attributes[name] ?? '') !== value));
      if (Object.keys(changed).length) {
        const { error: e } = await client.rpc('portal_set_unit_ebay_specifics', { p_sku: sku, p_attributes: changed });
        if (e) throw e;
      }
      if (useGeneratedDescription && generatedDescription.trim()) await persistDescription(generatedDescription);
      const r = await call('remember');
      show(r.form);
      setNotice(r.form.missing.length ? `Saved. Still needed: ${r.form.missing.join(', ')}.`
        : r.remembered ? 'Saved. Remembered for this UPC.' : 'Saved.');
      onSaved?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function makeDescription(item: Form['item'], currentSku: string) {
    const identity = [item?.brand, item?.model].filter(Boolean).join(' ');
    const name = item?.title?.trim() || identity || `Item ${currentSku}`;
    const condition = item?.condition?.trim() ? `Condition: ${item.condition.trim()}.` : '';
    const notes = item?.defect_notes?.trim() ? `Notes: ${item.defect_notes.trim()}.` : '';
    return [name.endsWith('.') ? name : `${name}.`, condition, notes].filter(Boolean).join('\n\n');
  }

  function input(f: Field) {
    const id = `aspect-${sku}-${f.name.replace(/\W+/g, '-')}`;
    const value = values[f.name] || '';
    const bad = Boolean(value && f.selection_only && f.allowed?.length && !f.allowed.includes(value));
    return <label key={f.name} className={`ebay-specific-field${f.required && (!value || bad) ? ' is-missing' : ''}`}>
      <span>{f.name}{f.required ? ' *' : ''}</span>
      <input value={value} list={f.allowed?.length ? id : undefined} placeholder={f.allowed?.length ? 'Search eBay values' : ''}
        onChange={(e) => setValues((old) => ({ ...old, [f.name]: e.target.value }))} />
      {f.allowed?.length ? <datalist id={id}>{f.allowed.map((v) => <option key={v} value={v} />)}</datalist> : null}
      {bad && <small className="alert">Pick one of eBay&apos;s values.</small>}</label>;
  }

  if (!form && !error) return <p className="hint" role="status">Loading eBay item specifics…</p>;
  if (form && !form.category_id && !canPick) {
    return <section className={`ebay-specifics${appMode ? ' app-ebay-specifics' : ''}`}>
      <h3>eBay item specifics</h3><p className="hint">An admin needs to pick this item&apos;s eBay category first.</p></section>;
  }
  return <section className={`ebay-specifics${appMode ? ' app-ebay-specifics' : ''}`} aria-label="eBay item specifics">
    <h3>eBay item specifics{form?.category_id ? ` · ${missing.length ? `${missing.length} required missing` : 'complete'}` : ''}</h3>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="hint" role="status">{notice}</p>}
    {form?.category_id && missing.length > 0 && <p className="ebay-specifics-missing" role="status">
      Fill these required eBay fields before listing: {missing.map((field) => field.name).join(', ')}.
    </p>}
    {form?.category_id && !form.item?.description?.trim() && !savedDescription && <label className="ebay-specifics-description-check">
      <input type="checkbox" checked={useGeneratedDescription} onChange={(e) => void toggleGenerated(e.currentTarget.checked)} />
      <span>Use generated description</span>
    </label>}
    {form?.category_id && useGeneratedDescription && !savedDescription && <label className="ebay-specifics-generated-description">
      Review generated description<textarea rows={5} value={generatedDescription} onChange={(e) => { setGeneratedDescription(e.currentTarget.value); onDescription?.(e.currentTarget.value); }} />
    </label>}
    {form && canPick && <div className="ebay-specifics-category">
      <p className="hint">{form.category_id ? `Category: ${form.path || form.category_id}` : 'No eBay category yet.'}</p>
      {!form.category_id && picked && <label className="ebay-specifics-suggestion">
        <input type="checkbox" checked={applyingSuggested} disabled={busy}
          onChange={(e) => toggleSuggestedCategory(e.currentTarget.checked)} />
        <span>Use suggested: {picked.path}</span>
      </label>}
      <label>{form.category_id ? 'Change eBay category' : 'Search eBay categories'}
        <input type="search" value={query} placeholder='e.g. "steamer"' onChange={(e) => setQuery(e.target.value)} /></label>
      {choices.length > 0 && <div className="category-results">{choices.map((c) => <button type="button" key={c.category_id}
        disabled={busy} onClick={() => void useCategory(c)}>{c.path}<small>{c.category_id}</small></button>)}</div>}
    </div>}
    {form?.category_id && <>
      {required.map(input)}
      {optional.length > 0 && <details><summary>Recommended (optional)</summary>{optional.map(input)}</details>}
      <button type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save item specifics'}</button>
    </>}
  </section>;
}
