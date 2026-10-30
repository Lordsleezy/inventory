import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cleanProductIdentity } from '@floor/store';

type Unit = { sku: string; brand: string; model: string; title: string; listing_body: string | null; state: string; qty_on_hand: number;
  upc: string | null; ask_cents: number | null; acquisition_cost_cents: number | null; condition: string | null; test_status: string | null;
  shippable: boolean | null; defect_notes: string | null; package_length_in: number | null; package_width_in: number | null;
  package_height_in: number | null; package_weight_lb: number | null };
type Draft = { brand: string; model: string; title: string };
const SELECT = 'sku,brand,model,title,listing_body,state,qty_on_hand,upc,ask_cents,acquisition_cost_cents,condition,test_status,shippable,defect_notes,package_length_in,package_width_in,package_height_in,package_weight_lb';

export function FixTitlesPage({ client, onChanged }: { client: SupabaseClient; onChanged?: () => void }) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [drafts, setDrafts] = useState<Record<string,Draft>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const all: Unit[] = [];
      for (let from=0;;from+=500) {
        const { data, error: e } = await client.from('units').select(SELECT)
          .in('state',['available','reserved','repair']).gt('qty_on_hand',0).order('sku').range(from,from+499);
        if (e) throw e;
        const page=(data||[]) as Unit[]; all.push(...page); if(page.length<500) break;
      }
      setUnits(all);
      const next: Record<string,Draft>={};
      for(const unit of all){
        const identity=cleanProductIdentity({brand:unit.brand,model:unit.model,title:unit.title,description:unit.listing_body});
        const suggestion={brand:identity.brand||'No brand',model:identity.model,title:identity.title};
        if(identity.review||suggestion.brand!==unit.brand||suggestion.model!==unit.model||suggestion.title!==unit.title) next[unit.sku]=suggestion;
      }
      setDrafts(next);
    } catch(e) { setError(e instanceof Error?e.message:String(e)); }
    setLoading(false);
  },[client]);
  useEffect(()=>{void load()},[load]);
  const flagged=useMemo(()=>units.filter(unit=>drafts[unit.sku]),[units,drafts]);

  async function accept(unit:Unit){
    const draft=drafts[unit.sku]; if(!draft) return true;
    if(!draft.brand.trim()||!draft.model.trim()||!draft.title.trim()){setError(`SKU ${unit.sku}: brand, model, and title are required before accepting.`);return false;}
    const {error:e}=await client.rpc('portal_update_unit',{
      p_sku:unit.sku,p_upc:unit.upc,p_brand:draft.brand.trim(),p_model:draft.model.trim(),p_title:draft.title.trim(),
      p_description:unit.listing_body,p_ask_cents:unit.ask_cents,p_cost_cents:unit.acquisition_cost_cents,
      p_condition:unit.condition,p_test_status:unit.test_status,p_shippable:unit.shippable?'ship':'pickup',p_notes:unit.defect_notes,
      p_length:unit.package_length_in,p_width:unit.package_width_in,p_height:unit.package_height_in,p_weight:unit.package_weight_lb,
    });
    if(e){setError(`SKU ${unit.sku}: ${e.message}`);return false;}
    setDrafts(old=>{const next={...old};delete next[unit.sku];return next;});
    return true;
  }

  async function acceptAll(){
    if(!flagged.length||!window.confirm(`Accept cleaned names for ${flagged.length} in-stock items?`))return;
    setBusy(true);setError('');
    for(const unit of flagged) if(!await accept(unit)) break;
    setBusy(false); onChanged?.();
  }

  return <section className="panel fix-titles-panel">
    <header><div><div className="eyebrow">INVENTORY TOOLS</div><h1>Fix titles</h1>
      <p>Review in-stock product names. Suggestions remove retailer names, repeated words and retail pack units, separate model from brand, and stay within 80 characters. Nothing changes until you accept it.</p></div></header>
    {error&&<p className="alert" role="alert">{error}</p>}
    {loading?<p>Checking in-stock items…</p>:<>
      <p>{flagged.length} items need review out of {units.length} in-stock SKUs.</p>
      {flagged.length>0&&<button type="button" disabled={busy} onClick={()=>void acceptAll()}>{busy?'Saving…':`Accept all ${flagged.length}`}</button>}
      <div className="fix-title-list">{flagged.map(unit=>{
        const draft=drafts[unit.sku]!;
        const identity=cleanProductIdentity({brand:unit.brand,model:unit.model,title:unit.title,description:unit.listing_body});
        return <article className="fix-title-row" key={unit.sku}>
          <strong>SKU {unit.sku}{unit.upc?` · UPC ${unit.upc}`:''}</strong>
          <div><span>Current</span><p>{unit.brand} · {unit.model} · {unit.title}</p></div>
          {identity.reasons.length>0&&<small>Review: {identity.reasons.join(', ').replaceAll('_',' ')}</small>}
          <label>Brand<input value={draft.brand} onChange={e=>setDrafts(old=>({...old,[unit.sku]:{...old[unit.sku]!,brand:e.target.value}}))}/></label>
          <label>Model<input value={draft.model} onChange={e=>setDrafts(old=>({...old,[unit.sku]:{...old[unit.sku]!,model:e.target.value}}))}/></label>
          <label>Title<input maxLength={80} value={draft.title} onChange={e=>setDrafts(old=>({...old,[unit.sku]:{...old[unit.sku]!,title:e.target.value}}))}/></label>
          <button type="button" disabled={busy} onClick={async()=>{setBusy(true);setError('');if(await accept(unit))onChanged?.();setBusy(false)}}>Accept SKU {unit.sku}</button>
        </article>;
      })}</div>
    </>}
  </section>;
}
