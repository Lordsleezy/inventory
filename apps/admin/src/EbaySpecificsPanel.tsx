import { useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';
import { AspectPicker } from './AspectPicker';
import { valueIsValid } from './aspectOptions';
import { categoryReview } from './categoryReview';

type Field = { name: string; required?: boolean; recommended?: boolean; allowed?: string[]; selection_only?: boolean };
type Form = { sku: string; upc: string | null; enabled: boolean; category_id: string | null; path: string | null; auto_picked?: boolean;
  review_reason?: string | null;
  category_issues?: string[];
  suggestion: { category_id: string; path: string } | null; fields: Field[]; attributes: Record<string, string>; missing: string[];
  usage?: Record<string, string[]>;
  item?: { title?: string; brand?: string; model?: string; condition?: string; description?: string; defect_notes?: string } };
type Choice = { category_id: string; path: string };
type Preview = { category_id: string; path: string | null; fields: Field[]; attributes: Record<string, string>; prefilled: string[]; cleared: string[]; usage: Record<string, string[]> };
type Props = { client: SupabaseClient; sku: string; storeId?: string; appMode?: boolean; onSaved?: () => void; hideSaveButton?: boolean;
  onJumpToCondition?: () => void;
  /** Item edit passes its Description box so a generated description lands in the form that Save changes writes. */
  onDescription?: (text: string) => void;
  /** Item edit calls this before its own Save so unsaved specifics / generated text are never lost. */
  persistRef?: { current: (() => Promise<void>) | null };
  dirtyRef?: { current: boolean };
  onDirtyChange?: (dirty: boolean) => void };

/** eBay item specifics: required first, eBay's allowed values as searchable lists. No AI. */
export function EbaySpecificsPanel({ client, sku, storeId, appMode = false, onSaved, hideSaveButton = false, onDescription, onJumpToCondition, persistRef, dirtyRef, onDirtyChange }: Props) {
  const [form, setForm] = useState<Form | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [canPick, setCanPick] = useState(false);
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<Choice[]>([]);
  const [suggestions, setSuggestions] = useState<Choice[]>([]);
  const [picked, setPicked] = useState<Choice | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewValues, setPreviewValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [generatedDescription, setGeneratedDescription] = useState('');
  const [useGeneratedDescription, setUseGeneratedDescription] = useState(false);
  const [savedDescription, setSavedDescription] = useState('');
  const pendingCategory = useRef<null | { category_id: string; values: Record<string,string> }>(null);

  async function call(action: string, extra: Record<string, unknown> = {}) {
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('Sign in again.');
    const response = await fetch(floorFunctionUrl('ebay-specifics'), { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_id: storeId, sku, action, ...extra }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'eBay specifics unavailable.');
    return result as { form: Form; remembered?: boolean } & Record<string, unknown>;
  }

  function show(next: Form) {
    setForm(next);
    setValues(next.attributes || {});
    setPicked(next.category_id ? null : next.suggestion);
    setPreview(null);
    setUseGeneratedDescription(false);
    setSavedDescription('');
    pendingCategory.current = null;
    setGeneratedDescription(next.item?.description?.trim() ? '' : makeDescription(next.item, sku));
    if (dirtyRef) dirtyRef.current = false;
    onDirtyChange?.(false);
  }

  useEffect(() => {
    let active = true;
    setError(''); setNotice('');
    void client.rpc('portal_unit_ebay_specifics', { p_sku: sku }).then(({ data }) => {
      if (active) setCanPick(Boolean((data as { can_pick_category?: boolean } | null)?.can_pick_category));
    });
    void call('suggest-category').then((r) => { if (active) show(r.form); })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [client, sku]);

  useEffect(() => {
    if (!canPick || !query.trim()) { setChoices([]); return; }
    let active = true;
    const timer = setTimeout(() => {
      void client.rpc('portal_category_search', { p_channel: 'ebay', p_query: query.trim(), p_limit: 60 })
        .then(({ data, error: e }) => { if (active) { if (e) setError(e.message); else setChoices((data || []) as Choice[]); } });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [client, canPick, query]);

  useEffect(() => {
    if (!canPick || !form?.item) { setSuggestions([]); return; }
    let active = true;
    const itemQuery = [form.item.brand, form.item.model, form.item.title].filter(Boolean).join(' ');
    if (!itemQuery.trim()) { setSuggestions([]); return; }
    void client.rpc('portal_category_search', { p_channel: 'ebay', p_query: itemQuery, p_limit: 3 })
      .then(({ data, error: e }) => { if (active) setSuggestions(e ? [] : (data || []) as Choice[]); });
    return () => { active = false; };
  }, [client, canPick, form?.item?.brand, form?.item?.model, form?.item?.title]);

  const required = useMemo(() => (form?.fields || []).filter((f) => f.required), [form]);
  const optional = useMemo(() => (form?.fields || []).filter((f) => !f.required && f.recommended), [form]);
  const missing = required.filter((f) => !values[f.name]?.trim()
    || (f.selection_only && f.allowed?.length && !f.allowed.includes(values[f.name].trim())));

  /** Tapping a category shows its required questions right here, answered where Floor can (nothing is saved yet). */
  async function openCategory(choice: Choice) {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await call('preview-category', { category_id: choice.category_id }) as unknown as Preview & { form?: Form };
      setPreview({ ...r, path: r.path || choice.path });
      setPreviewValues({ ...(r.attributes || {}) });
      setQuery('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  /** Stage the category and answers. The parent item Save commits this together with the rest. */
  async function confirmCategory() {
    if (!preview) return;
    setBusy(true); setError('');
    try {
      const answers = Object.fromEntries(preview.fields.map(f => [f.name, (previewValues[f.name] || '').trim()]).filter(([, v]) => v));
      pendingCategory.current = { category_id: preview.category_id, values: answers };
      if(form){setForm({...form, category_id:preview.category_id, path:preview.path||form.path, fields:preview.fields, attributes:{...form.attributes,...answers}, auto_picked:false});setValues({...values,...answers});}
      const categoryDirty = true;
      if (dirtyRef) dirtyRef.current = categoryDirty;
      onDirtyChange?.(categoryDirty);
      setPreview(null);
      setNotice('Category and answers will be saved with the item.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function confirmCurrentCategory() {
    if (!canPick || !form?.category_id) return;
    setBusy(true); setError(''); setNotice('');
    try {
      setNotice('Category confirmation will be applied when you Save.');
      if (dirtyRef) dirtyRef.current = true;
      onDirtyChange?.(true);
      setForm({ ...form, auto_picked: false });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
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
    if(pendingCategory.current){
      const pending=pendingCategory.current;
      const {data}=await client.auth.getSession();const token=data.session?.access_token;
      if(token){const response=await fetch(floorFunctionUrl('category-fields'),{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({store_id:storeId,channel:'ebay',category_id:pending.category_id})});if(!response.ok)throw new Error('Could not prepare eBay category fields.');}
      const {error:categoryError}=await client.rpc('portal_set_unit_ebay_category',{p_sku:sku,p_category_id:pending.category_id});if(categoryError)throw categoryError;
      const selected=await call('category-selected',{attributes:pending.values});
      const confirmed=await client.rpc('portal_set_unit_ebay_category',{p_sku:sku,p_category_id:pending.category_id});if(confirmed.error)throw confirmed.error;
      const refreshed=await call('get');show(refreshed.form);
      const cleared=(selected.cleared as string[]|undefined)||[];
      setNotice(cleared.length?`Category saved. Cleared incompatible values: ${cleared.join(', ')}.`:'Category saved.');
    }
    if (dirtyRef?.current) {
      const categoryId = form.category_id;
      if (!categoryId) throw new Error('Choose an eBay category before saving.');
      const { error: categoryError } = await client.rpc('portal_set_unit_ebay_category', { p_sku: sku, p_category_id: categoryId });
      if (categoryError) throw categoryError;
    }
    const changed = Object.fromEntries((form.fields || []).map((f) => [f.name, values[f.name] ?? ''])
      .filter(([name, value]) => (form.attributes[name] ?? '') !== value));
    if (Object.keys(changed).length) {
      const { error: e } = await client.rpc('portal_set_unit_ebay_specifics', { p_sku: sku, p_attributes: changed });
      if (e) throw e;
      setForm({ ...form, attributes: { ...form.attributes, ...changed } });
    }
    if (useGeneratedDescription && canPick) await persistDescription(generatedDescription);
    if (dirtyRef) dirtyRef.current = false;
    onDirtyChange?.(false);
    onSaved?.();
  }
  if (persistRef) persistRef.current = persist;

  async function toggleGenerated(on: boolean) {
    setUseGeneratedDescription(on);
    if (!on) return;
    onDescription?.(generatedDescription);
    // Item edit defers this until its single Save action.
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
    return <AspectPicker key={f.name} def={f} value={values[f.name] || ''} usage={form?.usage?.[f.name] || []}
      onChange={(v) => { setValues((old) => ({ ...old, [f.name]: v })); if(dirtyRef)dirtyRef.current=true; onDirtyChange?.(true); }} />;
  }

  const previewMissing = (preview?.fields || []).filter(f => f.required && !valueIsValid(f, previewValues[f.name] || ''));
  const review = categoryReview(form);

  if (!form && !error) return <p className="hint" role="status">Loading eBay item specifics…</p>;
  if (form && !form.category_id && !canPick) {
    return <section className={`ebay-specifics${appMode ? ' app-ebay-specifics' : ''}`}>
      <h3>eBay item specifics</h3><p className="hint">An admin needs to pick this item&apos;s eBay category first.</p></section>;
  }
  return <section className={`ebay-specifics${appMode ? ' app-ebay-specifics' : ''}`} aria-label="eBay item specifics">
    <h3>{`eBay item specifics${form?.category_id ? (missing.length ? ` · Missing ${missing.length}` : ' · Complete') : ''}`}</h3>
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
      <p className="hint">{form.category_id ? `Category: ${form.path || form.category_id}` : 'Floor could not match an eBay category automatically. Choose a suggestion or search below.'}{form.category_id && form.auto_picked ? <em className="aspect-suggested" title="Floor picked this from eBay's suggestion for the title. Look it over; tapping a category yourself clears the tag.">Auto</em> : null}</p>
      {review && <div className="ebay-specifics-missing" role="status"><p>{review.message}</p>
        {review.action === 'confirm' && <button type="button" disabled={busy} onClick={() => void confirmCurrentCategory()}>{busy ? '…' : '✓ Category looks right'}</button>}
        {review.action === 'condition' && <button type="button" disabled={busy} onClick={onJumpToCondition}>Go to Condition</button>}
        {review.action === 'specifics' && <button type="button" disabled={busy} onClick={() => document.querySelector('.ebay-specifics .ebay-specific-field.is-missing')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>Go to item specifics</button>}
      </div>}
      {!form.category_id && picked && !preview && <button type="button" className="ebay-specifics-suggestion" disabled={busy}
        onClick={() => void openCategory(picked)}>Use suggested: {picked.path}</button>}
      <label>{form.category_id ? 'Change eBay category' : 'Search eBay categories'}
        <input type="search" value={query} placeholder='e.g. "steamer"' onChange={(e) => setQuery(e.target.value)} />
      </label>
      {!query.trim() && suggestions.length > 0 && <><strong className="category-results-label">Suggested for this item</strong><div className="category-results">{suggestions.map((c) => <button type="button" key={c.category_id}
        disabled={busy} onClick={() => void openCategory(c)}>{c.path}<small>{c.category_id}</small></button>)}</div></>}
      {query.trim() && choices.length > 0 && <div className="category-results">{choices.map((c) => <button type="button" key={c.category_id}
        disabled={busy} onClick={() => void openCategory(c)}>{c.path}<small>{c.category_id}</small></button>)}</div>}
      {preview && <div className="category-step" role="group" aria-label="New category questions">
        <p className="hint"><strong>{preview.path || preview.category_id}</strong></p>
        {preview.cleared.length > 0 && <p className="hint">These current values do not fit this category and will be cleared: {preview.cleared.join(', ')}.</p>}
        {preview.fields.filter(f => f.required).map(f => <AspectPicker key={f.name} def={f} value={previewValues[f.name] || ''} usage={preview.usage?.[f.name] || []}
          suggested={preview.prefilled.includes(f.name)} onChange={(v) => setPreviewValues(old => ({ ...old, [f.name]: v }))} />)}
        {previewMissing.length > 0 && <p className="ebay-specifics-missing" role="status">Still needed before this item can be checked for eBay: {previewMissing.map(f => f.name).join(', ')}.</p>}
        <div className="actions"><button type="button" disabled={busy} onClick={() => void confirmCategory()}>{busy ? 'Preparing…' : 'Use this category'}</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setPreview(null)}>Cancel</button></div>
      </div>}
    </div>}
    {form?.category_id && <>
      {required.map(input)}
      {optional.length > 0 && <details><summary>Recommended (optional) · {optional.length} fields</summary>{optional.map(input)}</details>}
      {!hideSaveButton && <button type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save item specifics'}</button>}
    </>}
  </section>;
}
