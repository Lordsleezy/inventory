import { useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';
import { AspectPicker } from './AspectPicker';
import type { AspectDef } from './aspectOptions';
import { missingEbayAspects } from './receive-validation';

type Choice = { category_id: string; path: string; category_name?: string; best_match?: boolean };

export type AllowedGrade = { grade: string; conditionId: string; ebayName: string };

export type ReceiveAspectState = {
  categoryId: string | null;
  path: string | null;
  fields: AspectDef[];
  attributes: Record<string, string>;
  na: Record<string, boolean>;
  allowedGrades?: AllowedGrade[];
  conditionNote?: string;
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
  onChannelValues?: (values: Record<string, string>, missing: number) => void;
};

function plainCategoryError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || '');
  if (!raw || /_|sku_required|category_id|not_allowed/i.test(raw) || raw.length > 90) return "Couldn't load categories";
  return raw;
}

function categoryParts(path: string) {
  return path.split(/\s*>\s*/).map(part => part.trim()).filter(part => part && !/^root$/i.test(part));
}
function aspectFilled(def: AspectDef, attributes: Record<string, string>, na: Record<string, boolean>) {
  return missingEbayAspects([def], attributes, na).length === 0 && Boolean((attributes[def.name] || '').trim());
}

export function ReceiveCategoryAspects({
  client, storeId, accessToken, disabled, doNotList, identity, value, onChange, showErrors, channels, onChannelValues,
}: Props) {
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<Choice[]>([]);
  const [suggestions, setSuggestions] = useState<(Choice & { category_name?: string; best_match?: boolean })[]>([]);
  const [suggestError, setSuggestError] = useState('');
  const [fromUpc, setFromUpc] = useState<string[]>([]);
  const [browse, setBrowse] = useState<{ category_id: string; path: string; leaf: boolean; parent_id: string | null }[]>([]);
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preselectUsed = useRef(false);
  const suggestFor = useRef('');
  const pickGen = useRef(0);
  const [recommendedOpen, setRecommendedOpen] = useState(false);
  const [clearedNote, setClearedNote] = useState('');
  const [channelFields, setChannelFields] = useState<{ channel: 'amazon' | 'tiktok'; name: string; label: string; allowed?: string[] }[]>([]);
  const [channelValues, setChannelValues] = useState<Record<string, string>>({});
  const [channelNote, setChannelNote] = useState('');

  async function askEbay(title: string) {
    const res = await fetch(floorFunctionUrl('ebay-specifics'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_id: storeId, action: 'suggest-for-title', title }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error || 'eBay is unreachable. Retry, or browse the saved category tree. Nothing was saved.');
    return body as { suggestions?: (Choice & { category_name?: string; best_match?: boolean })[]; preselect?: Choice | null };
  }

  useEffect(() => {
    const typed = query.trim();
    if (typed.length < 3) { setChoices([]); return; }
    let active = true;
    const t = window.setTimeout(() => {
      void askEbay(typed).then((body) => { if (active) { setChoices(body.suggestions || []); setSuggestError(''); } })
        .catch((error) => { if (active) { setChoices([]); setSuggestError(plainCategoryError(error)); } });
    }, 450);
    return () => { active = false; clearTimeout(t); };
  }, [query, accessToken, storeId]);

  useEffect(() => {
    const q = [identity.title, identity.brand].filter(Boolean).join(' ').trim();
    if (suggestFor.current !== q) {
      suggestFor.current = q;
      preselectUsed.current = false;
      pickGen.current += 1;
    }
    const gen = pickGen.current;
    if (q.length < 3 || value.categoryId) { setSuggestions([]); return; }
    let active = true;
    const t = window.setTimeout(() => {
      void askEbay(q).then((body) => {
        if (!active) return;
        setSuggestError('');
        const list = body.suggestions || [];
        setSuggestions(list);
        const suggested = body.preselect || list.find(choice => choice.best_match) || list[0] || null;
        if (suggested && !preselectUsed.current && !value.categoryId) {
          preselectUsed.current = true;
          void pickCategory(suggested, gen);
        }
      }).catch((error) => {
        if (!active) return;
        setSuggestions([]);
        setSuggestError(plainCategoryError(error));
      });
    }, 0);
    return () => { active = false; clearTimeout(t); };
  }, [identity.title, identity.brand, value.categoryId, accessToken, storeId]);

  useEffect(() => {
    const wantAmazon = channels.includes('amazon');
    const wantTikTok = channels.includes('tiktok');
    if (!value.categoryId || (!wantAmazon && !wantTikTok)) { setChannelFields([]); setChannelNote(''); return; }
    let active = true;
    void (async () => {
      const { data, error } = await client.from('store_category_mappings').select('amazon_product_type,tiktok_category_id')
        .eq('store_id', storeId).eq('ebay_category_id', value.categoryId).maybeSingle();
      if (!active) return;
      if (error || !data) { setChannelFields([]); setChannelNote('No Amazon or TikTok category is mapped from this eBay category yet.'); return; }
      const lookups: { channel: 'amazon' | 'tiktok'; id: string }[] = [];
      if (wantAmazon && data.amazon_product_type) lookups.push({ channel: 'amazon', id: data.amazon_product_type });
      if (wantTikTok && data.tiktok_category_id) lookups.push({ channel: 'tiktok', id: data.tiktok_category_id });
      if (!lookups.length) { setChannelFields([]); setChannelNote('This eBay category has no saved Amazon product type or TikTok category.'); return; }
      const loaded: { channel: 'amazon' | 'tiktok'; name: string; label: string; allowed?: string[] }[] = [];
      for (const lookup of lookups) {
        const res = await client.from('channel_taxonomy').select('required_fields')
          .eq('channel', lookup.channel).eq('category_id', lookup.id).maybeSingle();
        const fields = (res.data?.required_fields || []) as { name?: string; label?: string; required?: boolean; allowed?: string[] }[];
        for (const field of fields) {
          if (field.required === false || !field.name) continue;
          loaded.push({ channel: lookup.channel, name: field.name, label: field.label || field.name, allowed: field.allowed });
        }
      }
      if (!active) return;
      setChannelFields(loaded);
      setChannelNote(loaded.length ? '' : 'The mapped Amazon or TikTok category has no cached required attributes yet. They still validate at list time.');
    })();
    return () => { active = false; };
  }, [client, storeId, value.categoryId, channels]);

  useEffect(() => {
    const missing = channelFields.filter(field => !(channelValues[`${field.channel}:${field.name}`] || '').trim()).length;
    onChannelValues?.(channelValues, missing);
  }, [channelValues, channelFields, onChannelValues]);

  const required = useMemo(() => value.fields.filter(f => f.required), [value.fields]);
  const recommended = useMemo(() => value.fields.filter(f => !f.required && f.recommended), [value.fields]);
  const filledRequired = required.filter(f => aspectFilled(f, value.attributes, value.na)).length;

  async function pickCategory(choice: Choice, gen?: number) {
    setBusy(true);
    setClearedNote('');
    try {
      const looked = await client.rpc('portal_ebay_category_form', { p_category_id: choice.category_id });
      const row = looked.error ? null : looked.data as { path?: string; fields?: AspectDef[] } | null;
      const res = await fetch(floorFunctionUrl('ebay-specifics'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store_id: storeId,
          action: 'preview-receive',
          category_id: choice.category_id,
          path: choice.path,
          identity,
          attributes: value.attributes,
        }),
      });
      const body = await res.json();
      if (!res.ok || body.ok === false) throw new Error(body.error || 'eBay is unreachable. Retry, or browse the saved category tree. Nothing was saved.');
      const fields = ((body.fields || row?.fields || []) as AspectDef[]);
      const attrs = (body.attributes || {}) as Record<string, string>;
      const keptNames = new Set(fields.map(f => f.name));
      const dropped = Object.keys(value.attributes).filter(k => !keptNames.has(k));
      if (dropped.length) setClearedNote(`Category changed — dropped ${dropped.join(', ')}.`);
      setFromUpc(Array.isArray(body.prefilled) ? body.prefilled.map((name: unknown) => String(name)) : []);
      if (gen !== undefined && gen !== pickGen.current) return;
      onChange({
        categoryId: choice.category_id,
        path: body.path || row?.path || choice.path,
        fields,
        attributes: attrs,
        na: Object.fromEntries(Object.entries(value.na).filter(([k]) => keptNames.has(k))),
        allowedGrades: (body.conditions || []) as ReceiveAspectState['allowedGrades'],
        conditionNote: String(body.conditionNote || ''),
      });
      setQuery('');
    } catch (e) {
      setSuggestError(plainCategoryError(e));
    } finally {
      setBusy(false);
    }
  }

  function setAttr(name: string, v: string) {
    onChange({ ...value, attributes: { ...value.attributes, [name]: v }, na: { ...value.na, [name]: false } });
  }

  return (
    <div className="receive-v2-span2 receive-aspects-block">
      <label className={showErrors && !value.categoryId ? 'receive-v2-invalid' : undefined}>
        <span>Category{!doNotList && <span className="receive-v2-req"> *</span>}</span>
        {value.path ? <p className="rcv-cat-full">{categoryParts(value.path).join(' › ')}</p> : null}
        <input
          value={query}
          disabled={disabled || busy}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search category"
          autoComplete="off"
        />
        {showErrors && !value.categoryId && <span className="receive-v2-msg">Pick a category</span>}
      </label>
      {suggestError && <p className="rcv-note" role="status">{suggestError} <button type="button" className="text-button" onClick={() => setQuery(q => q ? `${q} ` : identity.title)}>Retry</button></p>}
      {!value.categoryId && !query.trim() && suggestions.length > 0 && (
        <div>
          <span className="rcv-note">Suggested by eBay for this title</span>
          {suggestions.map(s => (
            <button key={s.category_id} type="button" className={`rcv-cat${value.categoryId === s.category_id ? ' is-on' : ''}`} disabled={busy} onClick={() => void pickCategory(s)}>
              <span className="rcv-radio" aria-hidden />
              <strong>{s.category_name || categoryParts(s.path).slice(-1)[0]}{s.best_match ? <em>Best match</em> : null}</strong>
              <small>{categoryParts(s.path).slice(0, -1).join(' › ')}</small>
            </button>
          ))}
        </div>
      )}
      {choices.length > 0 && (
        <div>
          {choices.slice(0, 8).map(c => (
            <button key={c.category_id} type="button" className="rcv-cat" disabled={busy} onClick={() => void pickCategory(c)}>
              <strong>{c.category_name || categoryParts(c.path).slice(-1)[0]}</strong>
              <small>{categoryParts(c.path).slice(0, -1).join(' › ')}</small>
            </button>
          ))}
        </div>
      )}
      {!value.categoryId && (
        <button type="button" className="text-button" onClick={() => {
          setBrowseParent(null);
          void client.from('channel_taxonomy').select('category_id,path,leaf,parent_id')
            .eq('channel', 'ebay').eq('active', true).is('parent_id', null).order('path').limit(40)
            .then(({ data }) => setBrowse((data || []) as typeof browse));
        }}>Browse all categories ›</button>
      )}
      {browse.length > 0 && !value.categoryId && (
        <div>
          {browseParent && <button type="button" className="text-button" onClick={() => {
            void client.from('channel_taxonomy').select('parent_id').eq('channel', 'ebay').eq('category_id', browseParent).maybeSingle()
              .then(({ data }) => {
                const parent = (data?.parent_id as string | null) ?? null;
                setBrowseParent(parent);
                const request = client.from('channel_taxonomy').select('category_id,path,leaf,parent_id').eq('channel', 'ebay').eq('active', true).order('path').limit(40);
                void (parent ? request.eq('parent_id', parent) : request.is('parent_id', null)).then(({ data: rows }) => setBrowse((rows || []) as typeof browse));
              });
          }}>Back</button>}
          {browse.map(row => (
            <button key={row.category_id} type="button" className="rcv-cat" disabled={busy} onClick={() => {
              if (!row.leaf) {
                setBrowseParent(row.category_id);
                void client.from('channel_taxonomy').select('category_id,path,leaf,parent_id')
                  .eq('channel', 'ebay').eq('active', true).eq('parent_id', row.category_id).order('path').limit(40)
                  .then(({ data }) => setBrowse((data || []) as typeof browse));
                return;
              }
              void pickCategory({ category_id: row.category_id, path: row.path });
            }}>
              <strong>{categoryParts(row.path).slice(-1)[0]}{row.leaf ? '' : ' ›'}</strong>
              {row.leaf ? <small>{categoryParts(row.path).slice(0, -1).join(' › ')}</small> : null}
            </button>
          ))}
        </div>
      )}
      {value.categoryId && (
        <>
          <p className="receive-aspects-head">Item specifics · {filledRequired} of {required.length} required filled</p>
          {clearedNote && <p className="rcv-note">{clearedNote}</p>}
          <div className="receive-v2-grid receive-aspects-fields">
            {required.map(def => {
              const missing = !aspectFilled(def, value.attributes, value.na);
              const showRed = showErrors || Boolean(value.categoryId);
              const picked = (value.attributes[def.name] || '').split('|').map(part => part.trim()).filter(Boolean);
              return (
                <div key={def.name} className={showRed && missing ? 'receive-aspect-missing' : undefined}>
                  {def.multi && def.allowed?.length ? (
                    <fieldset>
                      <legend>{def.name}{def.required ? ' *' : ''}</legend>
                      {def.allowed.map(option => (
                        <label key={option} className="rcv-check">
                          <input type="checkbox" checked={picked.includes(option)} disabled={disabled || busy}
                            onChange={e => {
                              const next = e.target.checked ? [...picked, option] : picked.filter(part => part !== option);
                              setAttr(def.name, next.join('|'));
                            }} />
                          {option}
                        </label>
                      ))}
                    </fieldset>
                  ) : (
                    <AspectPicker def={def} value={value.attributes[def.name] || ''} disabled={disabled || busy}
                      onChange={v => setAttr(def.name, v)} />
                  )}
                  {fromUpc.includes(def.name) && <small className="rcv-note">from UPC</small>}
                  {showRed && missing && <span className="receive-v2-msg">Required by eBay for this category</span>}
                </div>
              );
            })}
          </div>
          {recommended.length > 0 && (
            <details open={recommendedOpen} onToggle={e => setRecommendedOpen((e.target as HTMLDetailsElement).open)}>
              <summary>More specifics ({recommended.length} optional)</summary>
              <div className="receive-v2-grid">
                {recommended.map(def => (
                  <AspectPicker key={def.name} def={def} value={value.attributes[def.name] || ''} disabled={disabled || busy}
                    onChange={v => setAttr(def.name, v)} />
                ))}
              </div>
            </details>
          )}
          {(channels.includes('amazon') || channels.includes('tiktok')) && channelFields.length > 0 && (
            <div className="receive-v2-grid receive-aspects-fields">
              {channelFields.map(field => {
                const key = `${field.channel}:${field.name}`;
                const missing = !(channelValues[key] || '').trim();
                return <label key={key} className={missing ? 'receive-aspect-missing' : undefined}>
                  <span className="receive-v2-label">{field.label} <span className="receive-v2-req">*</span> <small className="receive-channel-tag">{field.channel === 'amazon' ? 'Amazon' : 'TikTok'}</small></span>
                  {field.allowed && field.allowed.length
                    ? <select value={channelValues[key] || ''} onChange={e => setChannelValues(v => ({ ...v, [key]: e.target.value }))}><option value="">Select</option>{field.allowed.map(opt => <option key={opt} value={opt}>{opt}</option>)}</select>
                    : <input value={channelValues[key] || ''} onChange={e => setChannelValues(v => ({ ...v, [key]: e.target.value }))} />}
                  {missing && <span className="receive-v2-msg">Required</span>}
                </label>;
              })}
            </div>
          )}
          {(channels.includes('amazon') || channels.includes('tiktok')) && !channelFields.length && (
            <p className="hint">{channelNote || 'Amazon and TikTok required attributes load from the saved category mapping. None are cached for this category yet, so they still validate at list time. UPC stays required when those channels are checked.'}</p>
          )}
        </>
      )}
    </div>
  );
}
