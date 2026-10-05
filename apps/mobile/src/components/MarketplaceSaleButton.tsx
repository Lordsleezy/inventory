import { useState } from "react";
import { authHeader, functionsUrl } from "../functions";
export function MarketplaceSaleButton({sku,askCents,disabled,onDone}:{sku:string;askCents:number|null;disabled:boolean;onDone:()=>Promise<void>}) {
  const [busy,setBusy]=useState(false);
  async function sell(){
    const channel=(window.prompt("Marketplace: mercari, poshmark, facebook, depop, other","mercari")||"").trim().toLowerCase();
    if(!["mercari","poshmark","facebook","depop","other"].includes(channel))return;
    const price=window.prompt("Actual sale price before fees ($)",askCents==null?"":(askCents/100).toFixed(2));
    if(price===null)return;const cents=Math.round(Number(price)*100);if(!Number.isSafeInteger(cents)||cents<=0)return;
    if(!window.confirm(`Mark SKU ${sku} sold on ${channel} for $${(cents/100).toFixed(2)}?`))return;
    setBusy(true);try{const headers=await authHeader();const res=await fetch(functionsUrl("marketplace-sale"),{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({sku,channel,price_cents:cents})});const body=await res.json().catch(()=>({}));if(!res.ok)throw new Error(body.error||`Sale failed (${res.status})`);await onDone();}catch(e){window.alert(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  return <button type="button" className="btn-text mt-3 block" disabled={disabled||busy} onClick={()=>void sell()}>{busy?"Recording sale�":"Mark sold on marketplace�"}</button>;
}
