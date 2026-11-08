import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';
import { AspectPicker } from './AspectPicker';
import type { AspectDef } from './aspectOptions';
import { valueIsValid } from './aspectOptions';

type Choice = { category_id: string; path: string };

export type ReceiveAspectState = {
  categoryId: string | null;
  path: string | null;
  fields: AspectDef[];
  attributes: Record<string, string>;
  na: Record<string, boolean>;
};

type Props = {
  client: SupabaseClient;
  storeId: string;
  accessToken: string;
  disabled?: boolean;
  doNotList: boolean;
  identity: { brand: string; model: string; title: string; condition: string; upc: string };
  value: ReceiveAspectState;
  onChange: (next: ReceiveAspectState) => void;
  showErrors: boolean;
  channels: string[];
};

function aspectFilled(def: AspectDef, attributes: Record<string, string>, na: Record<string, boolean>) {
  if (na[def.name]) return true;
  const v = (attributes[def.name] || '').trim();
  if (!v) return false;
  return valueIsValid(def, v);
}

export function ReceiveCategoryAspects({
  client, storeId, accessToken, disabled, doNotList, identity, value, onChange, showErrors, channels,
}: Props) {
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<Choice[]>([]);
  const [suggestions, setSuggestions] = useState<Choice[]>([]);
  const [busy, setBusy] = useState(false);
  const [recommendedOpen, setRecommendedOpen] = useState(false);
  const [clearedNote, setClearedNote] = useState('');

  useEffect(() => {
    if (!query.trim()) { setChoices([]); return; }
    let active = true;
    const t = window.setTimeout(() => {
      void client.rpc('portal_category_search', { p_channel: 'ebay', p_query: query.trim(), p_limit: 40 })
        .then(({ data, error }) => { if (active && !error) setChoices((data || []) as Choice[]); });
    }, 200);
    return () => { active = false; clearTimeout(t); };
  }, [client, query]);

  useEffect(() => {
    const q = [identity.brand, identity.model, identity.title].filter(Boolean).join(' ');
    if (!q.trim()) { setSuggestions([]); return; }
    let active = true;
    void client.rpc('portal_category_search', { p_channel: 'ebay', p_query: q, p_limit: 3 })
      .then(({ data }) => { if (active) setSuggestions((data || []) as Choice[]); });
    return () => { active = false; };
  }, [client, identity.brand, identity.model, identity.title]);

  const required = useMemo(() => value.fields.filter(f => f.required), [value.fields]);
  const recommended = useMemo(() => value.fields.filter(f => !f.required && f.recommended), [value.fields]);
  const filledRequired = required.filter(f => aspectFilled(f, value.attributes, value.na)).length;

  async function pickCategory(choice: Choice) {
    setBusy(true);
    setClearedNote('');
    try {
      const { data, error } = await client.rpc('portal_ebay_category_form', { p_category_id: choice.category_id });
      if (error) throw new Error(error.message);
      const row = data as { path?: string; fields?: AspectDef[] } | null;
      const fields = (row?.fields || []) as AspectDef[];
      const res = await fetch(floorFunctionUrl('ebay-specifics'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store_id: storeId,
          action: 'preview-receive',
          category_id: choice.category_id,
          identity,
          attributes: value.attributes,
        }),
      });
      const body = await res.json();
      const attrs = (body.attributes || {}) as Record<string, string>;
      const keptNames = new Set(fields.map(f => f.name));
      const dropped = Object.keys(value.attributes).filter(k => !keptNames.has(k));
      if (dropped.length) setClearedNote(`Category changed — dropped ${dropped.length} field${dropped.length === 1 ? '' : 's'} that don’t apply here.`);
      onChange({
        categoryId: choice.category_id,
        path: row?.path || choice.path,
        fields,
        attributes: attrs,
        na: Object.fromEntries(Object.entries(value.na).filter(([k]) => keptNames.has(k))),
      });
      setQuery('');
    } catch (e) {
      console.warn(e);
    } finally {
      setBusy(false);
    }
  }

  function setAttr(name: string, v: string) {
    onChange({ ...value, attributes: { ...value.attributes, [name]: v }, na: { ...value.na, [name]: false } });
  }

  function setNa(name: string, on: boolean) {
    onChange({
      ...value,
      na: { ...value.na, [name]: on },
      attributes: on ? { ...value.attributes, [name]: 'Does not apply' } : { ...value.attributes, [name]: '' },
    });
  }

  if (doNotList) return null;

  return (
    <div className="receive-v2-span2 receive-aspects-block">
      <label className={showErrors && !value.categoryId ? 'receive-v2-invalid' : undefined}>
        <span>Category<span className="receive-v2-req"> *</span></span>
        {value.path ? <p className="hint">{value.path}</p> : null}
        <input
          value={query}
          disabled={disabled || busy}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search category"
          autoComplete="off"
        />
        {showErrors && !value.categoryId && <span className="receive-v2-msg">Pick a category</span>}
      </label>
      {!value.categoryId && suggestions.length > 0 && (
        <div className="receive-aspect-suggestions">
          <span className="hint">Suggested</span>
          {suggestions.map(s => (
            <button key={s.category_id} type="button" className="text-button" disabled={busy} onClick={() => void pickCategory(s)}>
              {s.path}
            </button>
          ))}
        </div>
      )}
      {choices.length > 0 && !value.categoryId && (
        <ul className="scan-out-list">
          {choices.slice(0, 8).map(c => (
            <li key={c.category_id}>
              <button type="button" className="text-button" disabled={busy} onClick={() => void pickCategory(c)}>{c.path}</button>
            </li>
          ))}
        </ul>
      )}
      {value.categoryId && (
        <>
          <p className="receive-aspects-head">Item specifics · {filledRequired} of {required.length} required filled</p>
          {clearedNote && <p className="hint">{clearedNote}</p>}
          <div className="receive-v2-grid receive-aspects-fields">
            {required.map(def => {
              const missing = !aspectFilled(def, value.attributes, value.na);
              const showRed = showErrors || Boolean(value.categoryId);
              return (
                <div key={def.name} className={showRed && missing ? 'receive-aspect-missing' : undefined}>
                  <AspectPicker def={def} value={value.attributes[def.name] || ''} disabled={disabled || busy || value.na[def.name]}
                    onChange={v => setAttr(def.name, v)} />
                  {!def.selection_only && (
                    <label className="mboard-inline">
                      <input type="checkbox" checked={value.na[def.name] || false} disabled={disabled}
                        onChange={e => setNa(def.name, e.target.checked)} /> Does not apply
                    </label>
                  )}
                  {showErrors && missing && <span className="receive-v2-msg">Required</span>}
                </div>
              );
            })}
          </div>
          {recommended.length > 0 && (
            <details open={recommendedOpen} onToggle={e => setRecommendedOpen((e.target as HTMLDetailsElement).open)}>
              <summary>More details (optional)</summary>
              <div className="receive-v2-grid">
                {recommended.map(def => (
                  <AspectPicker key={def.name} def={def} value={value.attributes[def.name] || ''} disabled={disabled || busy}
                    onChange={v => setAttr(def.name, v)} />
                ))}
              </div>
            </details>
          )}
          {(channels.includes('amazon') || channels.includes('tiktok')) && (
            <p className="hint">Amazon and TikTok category attributes still validate at list time in Floor (UPC required when those channels are checked).</p>
          )}
        </>
      )}
    </div>
  );
}
