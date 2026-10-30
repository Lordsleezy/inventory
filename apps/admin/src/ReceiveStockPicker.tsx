import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { QuantityPicker } from './ReceiveQuantity';

export type StockMatch = { sku: string; title: string; quantity: number; price_cents: number | null; condition: string | null; is_stocked: boolean; can_convert: boolean; location?: string | null; photo?: string | null };

export function ReceiveStockPicker({ client, matches, admin, incomingPrice, incomingCondition, onAdd, onDismiss }: { client: SupabaseClient; matches: StockMatch[]; admin: boolean; incomingPrice: number | null | undefined; incomingCondition: string; onAdd: (match: StockMatch, quantity: number) => void; onDismiss: (newSku: boolean) => void }) {
  const [selected, setSelected] = useState<StockMatch | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [photos, setPhotos] = useState<Record<string, string>>({});
  useEffect(() => { setSelected(null); setQuantity('1'); const next: Record<string,string> = {}; let active=true;
    void Promise.all(matches.filter(m=>m.photo).map(async m=>{const {data}=await client.storage.from('unit-photos').createSignedUrl(m.photo!,3600); if(data?.signedUrl)next[m.sku]=data.signedUrl;})).then(()=>{if(active)setPhotos(next);});
    return ()=>{active=false;};
  }, [matches, client]);
  if (!matches.length) return null;
  const picked = matches.find(m=>m.sku===selected?.sku) || null;
  const add = () => {const q=Number(quantity);if(picked&&Number.isInteger(q)&&q>=1&&q<=999&&(picked.is_stocked||(admin&&picked.can_convert)))onAdd(picked,q);};
  return <div className="receive-modal stock-match-backdrop"><section className="receive-modal-card stock-match-modal" role="dialog" aria-modal="true" aria-labelledby="stock-match-title">
    <h2 id="stock-match-title">This item already exists in inventory</h2>
    <p>{matches.length===1?`Found SKU ${matches[0].sku}. Add this item to the existing SKU?`:'Choose the matching SKU. All matching in-stock items are listed.'}</p>
    <div className="stock-match-list">{matches.map(m=><div key={m.sku} className={`stock-match-option${selected?.sku===m.sku?' selected':''}`}>
      {photos[m.sku]?<img src={photos[m.sku]} alt=""/>:<span className="stock-match-photo-placeholder" aria-hidden="true">▧</span>}
      <span><b>SKU {m.sku} · {m.title}</b><small>{m.condition||'Condition not set'} · {m.price_cents==null?'No price':`$${(m.price_cents/100).toFixed(2)}`} · {m.quantity} on hand · {m.location||'Location not set'}</small>
        {(m.price_cents!==incomingPrice || m.condition!==incomingCondition) && <small className="stock-match-difference">{m.price_cents!==incomingPrice?'Price differs. ':''}{m.condition!==incomingCondition?'Condition differs.':''}</small>}
        {!m.is_stocked&&!admin&&<small>One-of-one item; only an admin can convert it to stocked.</small>}</span>
      <button type="button" className="secondary" disabled={!m.is_stocked&&(!admin||!m.can_convert)} aria-pressed={selected?.sku===m.sku} onClick={()=>setSelected(m)}>{selected?.sku===m.sku?'Selected':'Choose this SKU'}</button>
    </div>)}</div>
    {picked&&<div className="stock-match-confirm"><p>SKU {picked.sku} will have {picked.quantity}+ the received quantity on hand. The existing price and condition stay unchanged.</p>
      {!picked.is_stocked&&!admin&&<small>Ask an admin to convert this item, or choose No, create a new SKU.</small>}
      <QuantityPicker value={quantity} onChange={setQuantity} label="Quantity to add" maximum={999}/>
      <button type="button" disabled={!Number.isInteger(Number(quantity))||Number(quantity)<1||Number(quantity)>999||(!picked.is_stocked&&(!admin||!picked.can_convert))} onClick={add}>{picked.is_stocked?'Add to':'Convert and add to'} SKU {picked.sku}</button>
    </div>}
    <div className="stock-match-actions"><button type="button" className="secondary" onClick={()=>onDismiss(true)}>No, create a new SKU</button><button type="button" className="text-button" onClick={()=>onDismiss(false)}>Cancel</button></div>
  </section></div>;
}
