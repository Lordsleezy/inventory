import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MarketplacePrices } from './MarketplacePrices';
import { ListingsHealthPanel } from './ListingsHealthPanel';
import { VendooExportPanel } from './VendooExportPanel';
import { floorFunctionUrl } from './floorApi';
type Channel={key:string;label:string;aliases:string[]};
const defaultChannels:Channel[]=[{key:'vendoo',label:'Vendoo',aliases:['vendoo']},{key:'ebay',label:'eBay',aliases:['ebay','e bay']},{key:'mercari',label:'Mercari',aliases:['mercari']},{key:'poshmark',label:'Poshmark',aliases:['poshmark']},{key:'facebook',label:'Facebook Marketplace',aliases:['facebook','facebook marketplace','meta']},{key:'depop',label:'Depop',aliases:['depop']},{key:'etsy',label:'Etsy',aliases:['etsy']},{key:'grailed',label:'Grailed',aliases:['grailed']},{key:'vinted',label:'Vinted',aliases:['vinted']},{key:'vestiaire_collective',label:'Vestiaire Collective',aliases:['vestiaire collective','vestiaire']},{key:'shopify',label:'Shopify',aliases:['shopify']},{key:'other',label:'Other',aliases:[]}];
type Inv={sku:string;title:string|null;listed_on:string[];state:string;ask_cents:number|null;has_photo:boolean};
type Review={id:number;marketplace:string|null;subject:string|null;state:string;sku:string|null;item_title:string|null;order_number:string|null;sale_price_cents:number|null;ship_by:string|null;buyer:Record<string,string>;reason:string|null;created_at:string};
type Delist={id:number;sku:string;channel:string;created_at:string};
type ExportRow={sku:string;title:string;description:string;price_cents:number;condition:string|null;brand:string|null;category:string|null;photo_paths:string[];package_weight_lb:number|null;package_length_in:number|null;package_width_in:number|null;package_height_in:number|null;listed_on:string[];ebay_ok?:boolean;whatnot_ok?:boolean;depop_ok?:boolean;mercari_ok?:boolean;eligibility_notes?:string|null};
type EbayAccount={id:string;username:string;role:string;status:string;policiesReady?:boolean;hasFinances?:boolean;connected_at?:string|null;last_error?:string|null;scopes?:string[]};
type MigrationItem={source_item_id?:string;sourceItemId?:string;sku?:string|null;title?:string|null;price_cents?:number|null;priceCents?:number|null;outcome:string;reason?:string|null;dest_item_id?:string|null;destItemId?:string|null};
type EbayStatus={
  connected:boolean;
  username:string|null;
  connectedAt:string|null;
  lastSyncAt:string|null;
  lastError:string|null;
  ordersOnly:boolean;
  listingEnabled?:boolean;
  requiredUsername:string;
  disabled:boolean;
  hasFinances?:boolean;
  scopes?:string[];
  accounts?:EbayAccount[];
  sellingAccount?:EbayAccount|null;
  ordersOnlyAccount?:EbayAccount|null;
  migrationReady?:boolean;
  migration?:{
    ready:boolean;
    blockers:string[];
    plan?:{steps:string[];skipRules:string[]};
    latest?:{run:Record<string,unknown>;items:MigrationItem[]}|null;
  };
};
type Props={client:SupabaseClient;accessToken:string;money:(n:number)=>string;stamp?:(s:string)=>string};
const csv=(v:unknown)=>`"${String(v??'').replace(/"/g,'""')}"`;
function saveCsv(name:string,rows:unknown[][]){const text='\uFEFF'+rows.map(r=>r.map(csv).join(',')).join('\r\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));a.download=name;a.click();URL.revokeObjectURL(a.href);}
async function ebayCall(token:string,action:string,extra:Record<string,unknown>={}){
  const res=await fetch(floorFunctionUrl('ebay-connection'),{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({action,...extra})});
  const body=await res.json().catch(()=>({}));
  if(!res.ok||body.ok===false)throw new Error(body.error||`eBay request failed (${res.status})`);
  return body as EbayStatus & {
    ok:boolean;
    url?:string;
    orders?:unknown;
    started?:boolean;
    message?:string;
    summary?:Record<string,number>;
    items?:MigrationItem[];
    blockers?:string[];
    policies?:unknown;
    latest?:{run:Record<string,unknown>;items:MigrationItem[]}|null;
  };
}
function outcomeLabel(o:string){
  if(o==='will_move')return 'Will move';
  if(o==='moved')return 'Moved';
  if(o==='skipped')return 'Skipped';
  if(o==='failed')return 'Failed';
  return o;
}
export function MarketplacesPage({client,accessToken,money,stamp}:Props){
 const [inv,setInv]=useState<Inv[]>([]),[review,setReview]=useState<Review[]>([]),[ignored,setIgnored]=useState<Review[]>([]),[delists,setDelists]=useState<Delist[]>([]),[exp,setExp]=useState<ExportRow[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [channelOptions,setChannelOptions]=useState<Channel[]>(defaultChannels),[channelText,setChannelText]=useState('');
 const [ebay,setEbay]=useState<EbayStatus|null>(null);
 const [dryRun,setDryRun]=useState<{summary?:Record<string,number>;items?:MigrationItem[];blockers?:string[];message?:string}|null>(null);
 const channels=channelOptions.map(x=>x.key);
 const [sale,setSale]=useState<{sku:string;channel:string;price:string;order:string;fulfillment:string}|null>(null);
 const [reviewEdit,setReviewEdit]=useState<{row:Review;sku:string;channel:string;price:string}|null>(null);
 const [ebayError,setEbayError]=useState('');
 const loadEbay=useCallback(async()=>{try{const s=await ebayCall(accessToken,'status');setEbay(s);setEbayError('');}catch(e){setEbayError(e instanceof Error?e.message:String(e));}},[accessToken]);
 async function load(){setError('');try{const [a,b,c,d,ch]=await Promise.all([client.rpc('portal_marketplace_inventory'),client.rpc('portal_marketplace_email_sales'),client.rpc('portal_marketplace_delists'),client.rpc('portal_vendoo_export'),client.rpc('portal_marketplace_channels')]);for(const x of [a,b,c,d,ch])if(x.error)throw x.error;setInv(a.data||[]);setReview((b.data||[]).filter((x:Review)=>x.state==='needs_review'));setIgnored((b.data||[]).filter((x:Review)=>x.state==='ignored'&&(x.marketplace==='depop'||x.marketplace==='mercari')).slice(0,30));setDelists(c.data||[]);setExp(d.data||[]);const configured=(ch.data||defaultChannels) as Channel[];setChannelOptions(configured);setChannelText(configured.map(x=>x.key+' | '+x.label+' | '+x.aliases.join(', ')).join('\n'));await loadEbay();}catch(e){setError(e instanceof Error?e.message:String(e));}}
 useEffect(()=>{void load();},[]);
 async function listed(u:Inv,channel:string,checked:boolean){setBusy(true);try{const next=checked?[...new Set([...(u.listed_on||[]),channel])]:u.listed_on.filter(x=>x!==channel);const {error:e}=await client.rpc('portal_set_unit_listed_on',{p_sku:u.sku,p_channels:next});if(e)throw e;setNotice(`SKU ${u.sku} listing status saved.`);await load();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 async function sell(payload:Record<string,unknown>){setBusy(true);setError('');try{const res=await fetch(floorFunctionUrl('marketplace-sale'),{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'content-type':'application/json'},body:JSON.stringify(payload)});const body=await res.json();if(!res.ok)throw new Error(body.error||`Request failed ${res.status}`);setNotice(`Sale recorded for SKU ${String(payload.sku)}. Floor will delist it from the website and other channels.`);setSale(null);setReviewEdit(null);await load();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 async function rescanInbox(){setBusy(true);setError('');try{const res=await fetch(floorFunctionUrl('gmail-sales-poll'),{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'content-type':'application/json'},body:JSON.stringify({action:'rescan_inbox',include_seen:true})});const body=await res.json().catch(()=>({}));if(!res.ok)throw new Error(body.error||`Inbox rescan failed (${res.status})`);if(body.skipped)throw new Error(String(body.skipped));const matched=Number(body.matched||0),reviewN=Number(body.needs_review||0),ignoredN=Number(body.ignored||0),found=Number(body.found||0);setNotice(`Inbox rescan finished · found ${found} · matched ${matched} · review ${reviewN} · ignored ${ignoredN}. Check Live Sales / Orders / Review below.`);await load();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 async function exportVendoo(){setBusy(true);try{const {data,error:e}=await client.rpc('portal_vendoo_export');if(e)throw e;const rows=(data||[]) as ExportRow[];setExp(rows);const depopBlocked=rows.filter(x=>x.depop_ok===false).length;saveCsv(`OpenBox-Vendoo-${new Date().toISOString().slice(0,10)}.csv`,[['Title','Description','Price','Condition','Brand','Category','Photo URLs','Weight lb','Length in','Width in','Height in','SKU','eBay OK','Whatnot OK','Depop OK','Mercari OK','Eligibility notes'],...rows.map(x=>[x.title,`${x.description.replace(/\s*SKU\s+\d{5}\s*$/i,'').trim()}\n\nSKU ${x.sku}`,(x.price_cents/100).toFixed(2),/sealed|new/i.test(x.condition||'')&&!/open|damage/i.test(x.condition||'')?'New':/open|box|package/i.test(x.condition||'')?'New with defects / Open box':'Used',x.brand,x.category,x.photo_paths.map(p=>`https://openboxindustries.com/media/${p.split('/').map(encodeURIComponent).join('/')}`).join(' | '),x.package_weight_lb,x.package_length_in,x.package_width_in,x.package_height_in,x.sku,x.ebay_ok?'YES':'NO',x.whatnot_ok?'YES':'NO',x.depop_ok?'YES':'NO',x.mercari_ok?'YES':'NO',x.eligibility_notes||''])]);setNotice(`Exported ${rows.length} items eligible on at least one Vendoo channel.${depopBlocked?` ${depopBlocked} are blocked on Depop — do not crosslist those to Depop.`:' '}Use the OK columns as the crosslist checklist.`)}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 async function done(id:number){setBusy(true);try{const {error:e}=await client.rpc('portal_complete_marketplace_delist',{p_id:id});if(e)throw e;await load();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 async function saveChannels(){setBusy(true);setError('');try{const rows=channelText.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).map(line=>{const [key,label,aliases='']=line.split('|').map(x=>x.trim());return{key,label,aliases:aliases.split(',').map(x=>x.trim()).filter(Boolean)}});if(!rows.length)throw new Error('Keep at least one marketplace.');const {error:e}=await client.rpc('portal_set_online_setting',{p_key:'marketplace_channels',p_value:rows});if(e)throw e;setNotice('Marketplace list saved.');await load();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 const channelLabel=(key:string)=>channelOptions.find(x=>x.key===key)?.label||key;
 const counts=useMemo(()=>({listed:inv.filter(x=>x.listed_on?.length).length,review:review.length}),[inv,review]);
 const accounts=ebay?.accounts||[];
 const selling=ebay?.sellingAccount||null;
 const personal=ebay?.ordersOnlyAccount||null;
 const migration=ebay?.migration;
 const latestItems=(dryRun?.items||migration?.latest?.items||[]) as MigrationItem[];
 const latestSummary=dryRun?.summary||(migration?.latest?.run?.summary as Record<string,number>|undefined);

 return <><header><div><div className="eyebrow">SALES CHANNELS</div><h1>Marketplaces</h1><p>Connect the store business eBay account for selling, keep pgg124-5 as orders-only until open orders finish, then migrate listings. Export for Vendoo, record off-site sales, and clear delist reminders.</p></div><div className="actions"><button className="secondary" disabled={busy} onClick={()=>void load()}>Refresh</button><button disabled={busy} onClick={()=>{if(window.confirm('Re-scan the Depop/Mercari Gmail inbox (including already-read mail)? This re-evaluates previously ignored sale emails and will mark matching available units sold.'))void rescanInbox();}}>Re-scan sale emails</button></div></header>
 {error&&<div className="alert" role="alert">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}{notice&&<div className="hint">{notice}<button className="text-button" onClick={()=>setNotice('')}>Dismiss</button></div>}
 <div className="stats"><div className="stat"><span>Units listed elsewhere</span><strong>{counts.listed}</strong></div><div className="stat"><span>Sales to review</span><strong>{counts.review}</strong></div><div className="stat"><span>Delist reminders</span><strong>{delists.length}</strong></div></div>
 <ListingsHealthPanel client={client} stamp={stamp || ((s) => s)} />

 <section className="panel"><h2>eBay accounts</h2>
  <p>Floor supports more than one eBay account. The <strong>selling</strong> account is the store business account (new listings, sale ingest, auto-delist). <strong>Orders-only</strong> is for {ebay?.requiredUsername || 'pgg124-5'} until leftover orders ship — Floor never cancels those orders.</p>
  {ebay?.disabled ? <div className="alert" role="alert">eBay is fully disabled in Netlify (EBAY_DISABLED). Ask an operator to turn that off.</div> : <>
   {ebayError && <div className="alert" role="alert">Could not check eBay status: {ebayError}{ebay?' Showing the last known state below.':' Connection state is unknown.'} <button disabled={busy} onClick={()=>void loadEbay()}>Retry</button></div>}
   {!ebay && !ebayError && <p>Checking eBay status…</p>}
   {accounts.length===0 && ebay && !ebay.connected && <p>No eBay accounts connected yet.</p>}
   {accounts.length>0 && <div className="ticket-list">{accounts.map(a=><div className="ticket" key={a.id}>
     <div className="ticket-top"><strong>{a.username || 'unknown'}</strong><span>{a.role} · {a.status}{a.policiesReady ? ' · policies ready' : a.role==='selling' ? ' · policies needed' : ''}{a.hasFinances ? ' · finances OK' : ''}</span></div>
     {a.last_error && <p className="hint">Last error: {a.last_error}</p>}
     <div className="actions">
      {a.role==='selling' && a.status==='connected' && !a.policiesReady && <button disabled={busy} onClick={()=>void (async()=>{setBusy(true);setError('');try{await ebayCall(accessToken,'ensure_policies',{account_id:a.id});setNotice('Business policies created on the selling account.');await loadEbay();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}})()}>Create business policies</button>}
      {a.status==='connected' && <button className="secondary" disabled={busy} onClick={()=>void (async()=>{setBusy(true);setError('');try{const data=await ebayCall(accessToken,'sync_now',{account_id:a.id});setEbay(data);setNotice(`Sync finished for ${a.username}${Array.isArray(data.orders)?` · ${data.orders.length} result(s)`:''}.`);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}})()}>Sync orders</button>}
      {a.status==='connected' && <button className="text-button danger" disabled={busy} onClick={()=>{if(!window.confirm(`Disconnect ${a.username}?`))return;void (async()=>{setBusy(true);try{setEbay(await ebayCall(accessToken,'disconnect',{account_id:a.id}));setNotice(`${a.username} disconnected.`);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}})();}}>Disconnect</button>}
     </div>
   </div>)}</div>}
   <div className="actions" style={{marginTop:'1rem'}}>
    {!selling && <button disabled={busy} onClick={()=>void (async()=>{setBusy(true);setError('');try{const data=await ebayCall(accessToken,'connect_selling');if(data.url)window.location.href=data.url;}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}})()}>Connect selling account</button>}
    {!selling && <p className="hint">Opens eBay with a fresh login. Sign into the <strong>business</strong> seller — if you see {ebay?.requiredUsername || 'pgg124-5'}, use Switch accounts / Not you before approving.</p>}
    {!personal && <button className="secondary" disabled={busy} onClick={()=>void (async()=>{setBusy(true);setError('');try{const data=await ebayCall(accessToken,'connect_orders_only');if(data.url)window.location.href=data.url;}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}})()}>Connect {ebay?.requiredUsername || 'pgg124-5'} (orders only)</button>}
    {ebay?.connected && <button className="secondary" disabled={busy} onClick={()=>void (async()=>{setBusy(true);setError('');try{const data=await ebayCall(accessToken,'sync_now');setEbay(data);setNotice(`Sync finished${Array.isArray(data.orders)?` · ${data.orders.length} result(s)`:''}. Check the Orders tab.`);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}})()}>Sync all accounts now</button>}
   </div>
   {selling && !selling.policiesReady && <p className="hint">After connecting the business account, create its business policies (calculated shipping buyer-pays, no returns, payment). No local pickup.</p>}
   {ebay?.lastError && <p className="hint">Last sync error: {ebay.lastError}</p>}
  </>}
 </section>

 <section className="panel"><h2>eBay listing migration</h2>
  <p>Move every active store listing off {ebay?.requiredUsername || 'pgg124-5'} onto the business selling account. One listing at a time: end on source, create on destination at the same price, confirm live, update Floor. Open orders stay on {ebay?.requiredUsername || 'pgg124-5'}.</p>
  {migration?.blockers?.length ? <div className="alert" role="status">{migration.blockers.map(b=><div key={b}>{b}</div>)}</div> : <p className="hint">Prerequisites met{selling ? ` · selling: ${selling.username}` : ''}{personal ? ` · source: ${personal.username}` : ''}.</p>}
  <div className="actions">
   <button className="secondary" disabled={busy||!personal} onClick={()=>void (async()=>{setBusy(true);setError('');try{const data=await ebayCall(accessToken,'migration_dry_run');setDryRun({summary:data.summary,items:data.items,blockers:data.blockers,message:data.message});setNotice(data.message||`Dry-run finished · ${(data.summary?.will_move??0)} will move · ${(data.summary?.skipped??0)} skipped · ${(data.summary?.failed??0)} failed.`);await loadEbay();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}})()}>Dry-run migration</button>
   <button disabled={busy||!(migration?.ready||ebay?.migrationReady)} onClick={()=>{if(!window.confirm('Run the live migration now? Listings will be ended on the personal account and recreated on the business account one at a time. Open orders are skipped.'))return;void (async()=>{setBusy(true);setError('');try{const data=await ebayCall(accessToken,'migration_run');setNotice(data.message||'Migration started in the background.');await loadEbay();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}})();}}>Run migration</button>
   <button className="text-button" disabled={busy} onClick={()=>void (async()=>{setBusy(true);try{const data=await ebayCall(accessToken,'migration_latest');setEbay(await ebayCall(accessToken,'status'));if(data.latest){setDryRun({summary:data.latest.run?.summary as Record<string,number>,items:data.latest.items});setNotice('Loaded latest migration results.');}else setNotice('No migration runs yet.');}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}})()}>Load latest results</button>
  </div>
  {latestSummary && <p><strong>Summary:</strong> will move {latestSummary.will_move??0} · moved {latestSummary.moved??0} · skipped {latestSummary.skipped??0} · failed {latestSummary.failed??0} · total {latestSummary.total??latestItems.length}</p>}
  {latestItems.length>0 && <div className="ticket-list">{latestItems.slice(0,200).map((item,i)=>{
    const id=item.source_item_id||item.sourceItemId||String(i);
    const price=item.price_cents??item.priceCents;
    return <div className="ticket" key={id}><strong>{outcomeLabel(item.outcome)} · {item.title||id}</strong><small>Item {id}{item.sku?` · SKU ${item.sku}`:''}{price!=null?` · ${money(price)}`:''}{item.dest_item_id||item.destItemId?` → ${item.dest_item_id||item.destItemId}`:''}{item.reason?` · ${item.reason}`:''}</small></div>;
  })}{latestItems.length>200 && <p className="hint">Showing first 200 of {latestItems.length}.</p>}</div>}
  {!latestItems.length && <div className="empty">No dry-run or migration results yet. Connect both accounts, create policies, then run a dry-run.</div>}
 </section>

 <VendooExportPanel client={client} compact />
 <section className="panel"><h2>Marketplace sales</h2><p>Sale emails with an exact SKU and price are processed automatically. Unmatched emails wait here; confirm SKU and price before Floor marks anything sold.</p>{review.length===0?<div className="empty">No emails waiting for review.</div>:<div className="ticket-list">{review.map(r=><div className="ticket" key={r.id}><strong>{r.marketplace||'Marketplace'} — {r.item_title||r.subject}</strong><small>{r.reason||'Needs review'} — Order {r.order_number||'unknown'} — {r.ship_by?`Ship by ${r.ship_by}`:'No ship-by date'}</small>{reviewEdit?.row.id===r.id?<div className="actions"><input aria-label="SKU" inputMode="numeric" value={reviewEdit.sku} onChange={e=>setReviewEdit({...reviewEdit,sku:e.target.value})} placeholder="Exact Floor SKU"/><select value={reviewEdit.channel} onChange={e=>setReviewEdit({...reviewEdit,channel:e.target.value})}>{channels.map(x=><option key={x}>{x}</option>)}</select><input aria-label="Sale price" type="number" min="0.01" step="0.01" value={reviewEdit.price} onChange={e=>setReviewEdit({...reviewEdit,price:e.target.value})}/><button disabled={busy} onClick={()=>void sell({action:'approve_review',review_id:r.id,sku:reviewEdit.sku,channel:reviewEdit.channel,price_cents:Math.round(Number(reviewEdit.price)*100)})}>Confirm sale</button><button className="secondary" onClick={()=>setReviewEdit(null)}>Cancel</button></div>:<button className="secondary" onClick={()=>setReviewEdit({row:r,sku:r.sku||'',channel:r.marketplace||'mercari',price:r.sale_price_cents==null?'':(r.sale_price_cents/100).toFixed(2)})}>Review & match</button>}</div>)}</div>}</section>
 <section className="panel"><h2>Recently ignored Depop / Mercari mail</h2><p>These were read from the inbox but not treated as sales. After a parser fix, use <strong>Re-scan sale emails</strong> above — ignored Message-IDs are re-evaluated. Or use <strong>Mark sold</strong> on the unit below to record today&apos;s sale manually (delists everywhere, lands in Live Sales + Orders).</p>{ignored.length===0?<div className="empty">No recent ignored Depop/Mercari emails.</div>:<div className="ticket-list">{ignored.map(r=><div className="ticket" key={r.id}><strong>{r.marketplace||'Marketplace'} · {r.subject||r.item_title||'Email'}</strong><small>{r.reason||'Ignored'}{r.sku?` · SKU ${r.sku}`:''}{r.sale_price_cents!=null?` · ${money(r.sale_price_cents)}`:''} · {stamp?stamp(r.created_at):r.created_at}</small></div>)}</div>}</section>
 <section className="panel"><h2>Units and listing status</h2><p>Mark which channels currently list each unit. “Mark sold” is a manual fallback that records the sale in Floor and opens delist reminders.</p><div className="ticket-list">{inv.map(u=><div className="ticket" key={u.sku}><div className="ticket-top"><strong>{u.title||`SKU ${u.sku}`}</strong><span>SKU {u.sku} — {u.state} — {u.ask_cents==null?'No price':money(u.ask_cents)}</span></div><div className="actions">{channels.map(c=><label key={c}><input type="checkbox" checked={u.listed_on?.includes(c)} disabled={busy} onChange={e=>void listed(u,c,e.target.checked)}/> {channelLabel(c)}</label>)}{u.state==='available'&&<button className="text-button danger" onClick={()=>setSale({sku:u.sku,channel:(u.listed_on||[]).includes('depop')?'depop':(u.listed_on||[]).includes('mercari')?'mercari':(u.listed_on?.[0]||'depop'),price:(u.ask_cents?u.ask_cents/100:0).toFixed(2),order:'',fulfillment:'ship'})}>Mark sold</button>}</div><MarketplacePrices sku={u.sku} accessToken={accessToken} client={client} money={money}/></div>)}</div></section>
 <section className="panel"><h2>Marketplace list</h2><p>One marketplace per line: key | display name | email keywords. This list powers listing checkboxes, sold-on choices, email matching, delist alerts, Vendoo export, and reports.</p><label className="notes">Channels<textarea rows={12} value={channelText} onChange={e=>setChannelText(e.target.value)}/></label><button disabled={busy} onClick={()=>void saveChannels()}>Save marketplace list</button></section>
 <section className="panel"><h2>Delist reminders</h2>{delists.length===0?<div className="empty">No open reminders.</div>:<div className="ticket-list">{delists.map(d=><div className="ticket ticket-top" key={d.id}><strong>SKU {d.sku} sold — delist in {d.channel}</strong><button disabled={busy} onClick={()=>void done(d.id)}>Done</button></div>)}</div>}</section>
 {sale&&<div className="modal-backdrop"><form className="panel modal" onSubmit={e=>{e.preventDefault();const cents=Math.round(Number(sale.price)*100);if(cents>0&&window.confirm(`Record SKU ${sale.sku} sold on ${channelLabel(sale.channel)} for ${money(cents)}? This marks it sold in Floor.`))void sell({sku:sale.sku,channel:sale.channel,price_cents:cents,order_number:sale.order,fulfillment:sale.fulfillment});}}><h2>Record marketplace sale — SKU {sale.sku}</h2><label>Marketplace<select value={sale.channel} onChange={e=>setSale({...sale,channel:e.target.value})}>{channels.map(x=><option key={x}>{x}</option>)}</select></label><label>Sale price ($)<input required type="number" min="0.01" step="0.01" value={sale.price} onChange={e=>setSale({...sale,price:e.target.value})}/></label><label>Order number<input value={sale.order} onChange={e=>setSale({...sale,order:e.target.value})}/></label><label>Fulfillment<select value={sale.fulfillment} onChange={e=>setSale({...sale,fulfillment:e.target.value})}><option value="ship">To ship</option><option value="pickup">Pickup</option></select></label><div className="actions"><button disabled={busy}>Confirm sold</button><button type="button" className="secondary" onClick={()=>setSale(null)}>Cancel</button></div></form></div>}
 </>;
}
