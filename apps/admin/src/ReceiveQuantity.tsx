import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
export type ReceiveGroupMatch = { id: string; title: string; in_stock: number; fields: Record<string, string | number | null> };
export function ReceiveQuantity({ value, onChange, disabled = false }: { value: string; onChange: (n: string) => void; disabled?: boolean }) {
  const n = Math.max(1, Math.min(100, Number(value) || 1));
  return <fieldset disabled={disabled} className="receive-quantity"><legend>Quantity · each gets its own SKU</legend><div style={{display:'flex',gap:16,alignItems:'center'}}>
    <button type="button" style={{minWidth:56,minHeight:56,fontSize:28}} disabled={n<=1} aria-label="Decrease receive quantity" onClick={()=>onChange(String(n-1))}>−</button>
    <output style={{fontSize:28,minWidth:50,textAlign:'center'}} aria-live="polite">{value}</output>
    <button type="button" style={{minWidth:56,minHeight:56,fontSize:28}} disabled={n>=100} aria-label="Increase receive quantity" onClick={()=>onChange(String(n+1))}>+</button>
  </div><small>1–100 identical units. Price and entered cost are per unit. Use photos representative of every unit in this batch.</small></fieldset>;
}
export function ReceiveGroupPicker({client,upc,onChoose,selected}:{client:SupabaseClient;upc:string;onChoose:(g:ReceiveGroupMatch|null)=>void;selected:string|null}) {
  const [groups,setGroups]=useState<ReceiveGroupMatch[]>([]);
  useEffect(()=>{let active=true;setGroups([]);if(upc)void Promise.resolve(client.rpc('receive_group_lookup',{p_upc:upc})).then(({data,error})=>{if(active&&!error)setGroups(data||[])}).catch(()=>{});return()=>{active=false}},[client,upc]);
  if(!groups.length)return null;
  return <div className="receive-dup"><strong>In-stock groups with this UPC</strong>{groups.map(g=><p key={g.id}>{g.title} · {g.in_stock} in stock <button type="button" onClick={()=>onChoose(g)}>{selected===g.id?'Selected group':'Add more to this group'}</button></p>)}{selected&&<button type="button" onClick={()=>onChoose(null)}>Receive as a new group instead</button>}<small>A new batch needs representative photos. Existing units are unchanged.</small></div>;
}
