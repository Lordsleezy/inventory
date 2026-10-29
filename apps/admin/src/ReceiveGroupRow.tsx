import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import bwipjs from 'bwip-js/browser';
export type GroupedInventory = { group_id?: string | null; group_total?: number; group_in_stock?: number; group_skus?: string[]; group_members?: { sku: string; title: string; state: string; condition: string | null; ask_cents: number | null; sold_price_cents?: number | null; missing?: string[] }[] };
const EDIT_FIELDS = [['title','Title'],['brand','Brand'],['model','Model'],['category','Category'],['listing_body','Description'],['condition','Condition'],['ask_cents','Price ($)'],['package_length_in','Package length (in)'],['package_width_in','Package width (in)'],['package_height_in','Package height (in)'],['package_weight_lb','Package weight (lb)'],['upc','UPC']] as const;
export async function printUnitLabels(skus: string[], title: string) {
  const sheet = window.open('', '_blank');
  if (!sheet) throw new Error('Allow the print window and try again.');
  const doc=sheet.document;doc.title='Floor SKU labels';
  const style=doc.createElement('style');style.textContent='@page{size:2in 1in;margin:0}body{margin:0;font-family:Arial}section{box-sizing:border-box;width:2in;height:1in;padding:.08in;page-break-after:always;overflow:hidden;text-align:center}svg{width:1.8in;height:.45in}small{font-size:9px;display:block}b{font-size:15px}';doc.head.append(style);
  for(const sku of skus){const label=doc.createElement('section');const caption=doc.createElement('small');caption.textContent=title;label.append(caption);const barcode=doc.createElement('div');barcode.innerHTML=bwipjs.toSVG({bcid:'code128',text:sku,scale:2,height:10,includetext:false});label.append(barcode);const id=doc.createElement('b');id.textContent=sku;label.append(id);doc.body.append(label)}
  sheet.focus();sheet.print();
}
export function ReceiveGroupRow({item,client,admin,money,onOpen,onChanged}:{item:GroupedInventory & {sku:string;title:string;brand?:string;model?:string;ask_cents:number|null;condition:string|null};client:SupabaseClient;admin:boolean;money:(n:number)=>string;onOpen:(sku:string,missing?:string[])=>void;onChanged:()=>void}) {
  const [editing,setEditing]=useState(false);const [patch,setPatch]=useState<Record<string,string>>({});const [error,setError]=useState('');const [busy,setBusy]=useState(false);
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
  return <details className="receive-inventory-group" style={{padding:16,borderBottom:'1px solid #444'}}><summary style={{cursor:'pointer',minHeight:48,fontWeight:700}}>{item.title || [item.brand,item.model].filter(Boolean).join(' ')} ×{item.group_total} ({item.group_in_stock} in stock)</summary>
    <small>{item.group_members?.length || 0} matching units below. Each SKU sells and edits separately.</small>
    {item.group_members?.map(unit=><button type="button" className="app-row inventory-row" key={unit.sku} onClick={()=>onOpen(unit.sku,unit.missing)}><span>SKU {unit.sku} · {unit.condition} · {unit.state}<small style={{display:'block',color:'#f59e0b'}}>{unit.missing?.length ? 'Missing: '+unit.missing.join(', ') : ''}</small></span><span>{unit.state==='sold' ? admin && unit.sold_price_cents != null ? money(unit.sold_price_cents) : '' : unit.ask_cents==null?'—':money(unit.ask_cents)}</span></button>)}
    <button type="button" onClick={()=>void printUnitLabels(item.group_skus || item.group_members?.map(m=>m.sku)||[],item.title).catch(e=>setError(e.message))}>Print labels · {item.group_skus?.length || item.group_total} SKUs</button>
    {admin&&<button type="button" onClick={()=>setEditing(!editing)}>Apply price / details to all in-stock units in this group</button>}
    {editing&&<div><p>Only fields you change below are applied. Costs and channels are never changed here.</p>{EDIT_FIELDS.map(([key,label])=><label key={key} style={{display:'block'}}>{label}<input value={patch[key] || ''} placeholder="Leave unchanged" onChange={e=>setPatch(p=>({...p,[key]:e.target.value}))} /></label>)}<button type="button" disabled={busy} onClick={()=>void apply()}>Apply to group</button><button type="button" onClick={()=>setEditing(false)}>Cancel</button></div>}
    {error&&<p role="alert">{error}</p>}
  </details>;
}
