import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import bwipjs from 'bwip-js/browser';
export type GroupMember = { sku: string; title: string; state: string; condition: string | null; ask_cents: number | null; sold_price_cents?: number | null; missing?: string[]; defective?: boolean; not_for_sale?: boolean };
export type GroupedInventory = { group_id?: string | null; group_total?: number; group_in_stock?: number; group_skus?: string[]; group_members?: GroupMember[] };
const EDIT_FIELDS = [['title','Title'],['brand','Brand'],['model','Model'],['category','Category'],['listing_body','Description'],['condition','Condition'],['ask_cents','Price ($)'],['package_length_in','Package length (in)'],['package_width_in','Package width (in)'],['package_height_in','Package height (in)'],['package_weight_lb','Package weight (lb)'],['upc','UPC']] as const;
export async function printUnitLabels(skus: string[], title: string) {
  const sheet = window.open('', '_blank');
  if (!sheet) throw new Error('Allow the print window and try again.');
  const doc=sheet.document;doc.title='Floor SKU labels';
  const style=doc.createElement('style');style.textContent='@page{size:2in 1in;margin:0}body{margin:0;font-family:Arial}section{box-sizing:border-box;width:2in;height:1in;padding:.08in;page-break-after:always;overflow:hidden;text-align:center}svg{width:1.8in;height:.45in}small{font-size:9px;display:block}b{font-size:15px}';doc.head.append(style);
  for(const sku of skus){const label=doc.createElement('section');const caption=doc.createElement('small');caption.textContent=title;label.append(caption);const barcode=doc.createElement('div');barcode.innerHTML=bwipjs.toSVG({bcid:'code128',text:sku,scale:2,height:10,includetext:false});label.append(barcode);const id=doc.createElement('b');id.textContent=sku;label.append(id);doc.body.append(label)}
  sheet.focus();sheet.print();
}
export function ReceiveGroupRow({item,client,admin,money,onOpen,onChanged,searchQuery=''}:{item:GroupedInventory & {sku:string;title:string;brand?:string;model?:string;ask_cents:number|null;condition:string|null};client:SupabaseClient;admin:boolean;money:(n:number)=>string;onOpen:(sku:string,missing?:string[])=>void;onChanged:()=>void;searchQuery?:string}) {
  const [editing,setEditing]=useState(false);const [patch,setPatch]=useState<Record<string,string>>({});const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const [members,setMembers]=useState<GroupMember[]>(item.group_members||[]);const [expanded,setExpanded]=useState(false);
  const [groupAction,setGroupAction]=useState<'giveaway'|'defective'|null>(null);const [quantity,setQuantity]=useState(1);const [givenTo,setGivenTo]=useState('');
  const skus=[...new Set(item.group_skus||item.group_members?.map(m=>m.sku)||[])].sort((a,b)=>Number(a)-Number(b));
  const groupTotal=item.group_total??skus.length;
  const matchingSku=searchQuery.trim()&&/^\d+$/.test(searchQuery.trim())?searchQuery.trim():null;
  async function loadMembers(){
    if(!item.group_id||expanded)return;setExpanded(true);
    const current=item.group_members||[];
    if(current.length===item.group_total)return;
    setBusy(true);
    const results=await Promise.all(skus.map(async sku=>{const {data,error:e}=await client.rpc('portal_inventory_detail',{p_sku:sku});if(e||!data)return null;const d=data as {unit?:Record<string,unknown>};const u=d.unit||{};return {sku,title:String(u.title||''),state:String(u.state||''),condition:u.condition==null?null:String(u.condition),ask_cents:u.ask_cents==null?null:Number(u.ask_cents),sold_price_cents:u.sold_price_cents==null?undefined:Number(u.sold_price_cents),missing:Array.isArray(u.missing)?u.missing.map(String):[],defective:Boolean(u.defective),not_for_sale:Boolean(u.not_for_sale)} as GroupMember;}));
    setMembers(results.filter((x):x is GroupMember=>Boolean(x)));setBusy(false);
  }
  async function apply(){
    if(!window.confirm('Apply these fields to every attached, in-stock unit in this group? Sold and individually edited units stay unchanged.'))return;
    const data:Record<string,unknown>={};
    for(const [key,value] of Object.entries(patch)) {
      if(key==='ask_cents'){if(value && !/^\d+(\.\d{1,2})?$/.test(value)){setError('Enter a valid price.');return}data[key]=value?Math.round(Number(value)*100):null}
      else if(key.startsWith('package_')){if(value && (!Number.isFinite(Number(value)) || Number(value)<=0)){setError('Measurements must be positive.');return}data[key]=value?Number(value):null}
      else data[key]=value;
    }
    if(!Object.keys(data).length)return;
    setBusy(true);const {error:e}=await client.rpc('receive_group_apply',{p_group:item.group_id,p_patch:data});setBusy(false);
    if(e){setError(e.message);return}setPatch({});setEditing(false);onChanged();
  }
  async function runGroupAction(){
    const eligible=members.filter(m=>['available','reserved','repair'].includes(m.state)).sort((a,b)=>Number(a.sku)-Number(b.sku)).slice(0,quantity);
    if(eligible.length!==quantity){setError('Some group units could not be loaded. Expand again after refreshing and retry.');return;}
    if(groupAction==='giveaway'&&!givenTo.trim())return;
    if(!window.confirm(groupAction==='giveaway'?`Give away ${eligible.length} of ${item.group_in_stock} units to ${givenTo.trim()}? Lowest in-stock SKUs: ${eligible.map(m=>m.sku).join(', ')}.`:`Mark ${eligible.length} of ${item.group_in_stock} units defective? Lowest in-stock SKUs: ${eligible.map(m=>m.sku).join(', ')}.`))return;
    setBusy(true);setError('');let done=0;
    if(groupAction==='defective'){
      const {error:e}=await client.rpc('portal_receive_group_mark_defective',{p_group:item.group_id,p_skus:eligible.map(m=>m.sku)});
      setBusy(false);if(e){setError(e.message);return;}setGroupAction(null);onChanged();return;
    }
    for(const member of eligible){
      const {error:e}=await client.rpc('portal_record_giveaway',{p_sku:member.sku,p_given_to:givenTo.trim(),p_note:null});
      if(e){setError(`${done} unit(s) updated; SKU ${member.sku} failed: ${e instanceof Error?e.message:String(e)}`);break;}done++;
    }
    setBusy(false);if(done){setGroupAction(null);setGivenTo('');onChanged();}
  }
  return <details className="receive-inventory-group" style={{padding:16,borderBottom:'1px solid #444'}} open={expanded} onToggle={e=>{if(e.currentTarget.open)void loadMembers();else setExpanded(false)}}><summary style={{cursor:'pointer',minHeight:48,fontWeight:700}}>{item.title || [item.brand,item.model].filter(Boolean).join(' ')} ×{item.group_total} ({item.group_in_stock} in stock)</summary>
    <small>{members.length} of {groupTotal} group units shown. Each SKU sells and edits separately.</small>
    {busy&&members.length<groupTotal&&<p role="status">Loading all units…</p>}
    {members.map(unit=><button type="button" className={`app-row inventory-row${unit.sku===matchingSku?' receive-group-match':''}`} key={unit.sku} onClick={()=>onOpen(unit.sku,unit.missing)}><span>SKU {unit.sku} · {unit.condition||'No grade'} · {unit.state}{unit.sku===matchingSku&&<small>Search match</small>}<small style={{display:'block',color:'#f59e0b'}}>{unit.missing?.length ? 'Missing: '+unit.missing.join(', ') : ''}</small></span><span>{unit.state==='sold' ? admin && unit.sold_price_cents != null ? money(unit.sold_price_cents) : '' : unit.ask_cents==null?'—':money(unit.ask_cents)}</span></button>)}
    <button type="button" onClick={()=>void printUnitLabels(item.group_skus || item.group_members?.map(m=>m.sku)||[],item.title).catch(e=>setError(e.message))}>Print labels · {item.group_skus?.length || item.group_total} SKUs</button>
    {admin&&<><button type="button" onClick={()=>{setGroupAction('giveaway');setQuantity(1)}}>Give away</button><button type="button" onClick={()=>{setGroupAction('defective');setQuantity(1)}}>Mark defective</button></>}
    {admin&&groupAction&&<div className="receive-group-action"><label>Quantity (lowest in-stock SKUs)<input type="number" min={1} max={Math.max(1,item.group_in_stock||1)} value={quantity} onChange={e=>setQuantity(Math.max(1,Math.min(Number(e.target.value)||1,item.group_in_stock||1)))} /></label>{groupAction==='giveaway'&&<label>Given to<input value={givenTo} onChange={e=>setGivenTo(e.target.value)} /></label>}<p>{groupAction==='giveaway'?'Each unit records its actual cost in Giveaways.':'Selected units are moved into Defective.'}</p><button type="button" disabled={busy||(groupAction==='giveaway'&&!givenTo.trim())} onClick={()=>void runGroupAction()}>{groupAction==='giveaway'?`Give away ${quantity} of ${item.group_in_stock}`:`Mark ${quantity} defective`}</button><button type="button" className="secondary" disabled={busy} onClick={()=>setGroupAction(null)}>Cancel</button></div>}
    {admin&&<button type="button" onClick={()=>setEditing(!editing)}>Apply price / details to all in-stock units in this group</button>}
    {editing&&<div><p>Only fields you change below are applied. Costs and channels are never changed here.</p>{EDIT_FIELDS.map(([key,label])=><label key={key} style={{display:'block'}}>{label}<input value={patch[key] || ''} placeholder="Leave unchanged" onChange={e=>setPatch(p=>({...p,[key]:e.target.value}))} /></label>)}<button type="button" disabled={busy} onClick={()=>void apply()}>Apply to group</button><button type="button" onClick={()=>setEditing(false)}>Cancel</button></div>}
    {error&&<p role="alert">{error}</p>}
  </details>;
}
