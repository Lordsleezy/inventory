import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MarketplacePrices } from './MarketplacePrices';
import { TikTokShopPanel } from './TikTokShopPanel';
import { floorFunctionUrl } from './floorApi';
import { errText } from './errText';
type Channel={key:string;label:string;aliases:string[]};
/** Active list targets + sale-ingest labels. Mercari kept for email sale matching / history only. */
const defaultChannels:Channel[]=[
  {key:'ebay',label:'eBay',aliases:['ebay','e bay']},
  {key:'depop',label:'Depop',aliases:['depop']},
  {key:'amazon',label:'Amazon',aliases:['amazon']},
  {key:'tiktok',label:'TikTok Shop',aliases:['tiktok','tiktok shop']},
  {key:'facebook',label:'Facebook Marketplace',aliases:['facebook','facebook marketplace','meta']},
  {key:'mercari',label:'Mercari (sales only)',aliases:['mercari']},
  {key:'other',label:'Other',aliases:[]},
];
/** Channels you can still toggle from the checklist (Depop requires Listing manager → Push). */
const CHECKLIST_CHANNELS = ['ebay', 'amazon', 'tiktok', 'facebook'];
type Inv={sku:string;title:string|null;listed_on:string[];state:string;ask_cents:number|null;has_photo:boolean};
type Review={id:number;marketplace:string|null;subject:string|null;state:string;sku:string|null;item_title:string|null;order_number:string|null;sale_price_cents:number|null;ship_by:string|null;buyer:Record<string,string>;reason:string|null;created_at:string};
type Delist={id:number;sku:string;channel:string;created_at:string};
type EbayAccount={id:string;username:string;role:string;status:string;policiesReady?:boolean;hasFinances?:boolean;connected_at?:string|null;last_error?:string|null;scopes?:string[]};
type MigrationItem={source_item_id?:string;sourceItemId?:string;sku?:string|null;title?:string|null;price_cents?:number|null;priceCents?:number|null;outcome:string;reason?:string|null;dest_item_id?:string|null;destItemId?:string|null};
type EbaySyncNow={
  status?:string;
  requested_at?:string;
  started_at?:string|null;
  finished_at?:string|null;
  error?:string|null;
  message?:string;
  progress?:{phase?:string;current?:number;total?:number;username?:string;message?:string};
  summary?:{accounts?:number;results?:number;errors?:number;ok_accounts?:number;failed_accounts?:number}|null;
  account_results?:{username?:string;role?:string;ok?:boolean;result_count?:number;matched?:number;skipped?:number;errors?:string[]}[];
};
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
  syncNow?:EbaySyncNow|null;
  migration?:{
    ready:boolean;
    blockers:string[];
    plan?:{steps:string[];skipRules:string[]};
    latest?:{run:Record<string,unknown>;items:MigrationItem[]}|null;
  };
};
type Props={client:SupabaseClient;accessToken:string;money:(n:number)=>string;stamp?:(s:string)=>string};
async function ebayCall(token:string,action:string,extra:Record<string,unknown>={}){
  const res=await fetch(floorFunctionUrl('ebay-connection'),{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({action,...extra})});
  const body=await res.json().catch(()=>({}));
  if(!res.ok||body.ok===false)throw new Error(body.error||`eBay request failed (${res.status})`);
  return body as EbayStatus & {
    ok:boolean;
    url?:string;
    orders?:unknown;
    started?:boolean;
    alreadyRunning?:boolean;
    message?:string;
    summary?:Record<string,number>;
    items?:MigrationItem[];
    blockers?:string[];
    policies?:unknown;
    syncNow?:EbaySyncNow|null;
    latest?:{run:Record<string,unknown>;items:MigrationItem[]}|null;
  };
}
function syncNowRunning(s?:EbaySyncNow|null){
  return !!s && ['queued','started','running'].includes(String(s.status||''));
}
function formatSyncNotice(sync?:EbaySyncNow|null){
  if(!sync)return 'eBay sync finished.';
  const sum=sync.summary;
  if(sum){
    return `eBay sync ${sync.status||'done'} · ${sum.ok_accounts??0}/${sum.accounts??0} account(s) · ${sum.results??0} result(s)${sum.failed_accounts?` · ${sum.failed_accounts} with errors`:''}. Check Orders.`;
  }
  return sync.progress?.message||sync.message||`eBay sync ${sync.status||'done'}.`;
}
function outcomeLabel(o:string){
  if(o==='will_move')return 'Will move';
  if(o==='moved')return 'Moved';
  if(o==='skipped')return 'Skipped';
  if(o==='failed')return 'Failed';
  return o;
}
export function MarketplacesPage({client,accessToken,money,stamp}:Props){
 const [inv,setInv]=useState<Inv[]>([]),[review,setReview]=useState<Review[]>([]),[ignored,setIgnored]=useState<Review[]>([]),[delists,setDelists]=useState<Delist[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [channelOptions,setChannelOptions]=useState<Channel[]>(defaultChannels),[channelText,setChannelText]=useState('');
 const [ebay,setEbay]=useState<EbayStatus|null>(null);
 const [dryRun,setDryRun]=useState<{summary?:Record<string,number>;items?:MigrationItem[];blockers?:string[];message?:string}|null>(null);
 const channels=channelOptions.map(x=>x.key);
 const [sale,setSale]=useState<{sku:string;channel:string;price:string;order:string;fulfillment:string}|null>(null);
 const [reviewEdit,setReviewEdit]=useState<{row:Review;sku:string;channel:string;price:string}|null>(null);
 const [ebayError,setEbayError]=useState('');
 const [syncPolling,setSyncPolling]=useState(false);
 const pollEbaySync=useCallback(async()=>{
   setSyncPolling(true);
   try{
     for(let i=0;i<90;i++){
       await new Promise(r=>setTimeout(r,2000));
       const latest=await ebayCall(accessToken,'sync_latest');
       setEbay(latest);
       const sync=latest.syncNow;
       if(sync?.progress?.message)setNotice(sync.progress.message);
       if(!syncNowRunning(sync)){
         setNotice(formatSyncNotice(sync));
         return;
       }
     }
     setNotice('eBay sync still running — hit Refresh sync status in a minute.');
   }catch(e){setError(errText(e));}
   finally{setSyncPolling(false);}
 },[accessToken]);
 const loadEbay=useCallback(async()=>{
   try{
     const s=await ebayCall(accessToken,'status');
     setEbay(s);setEbayError('');
     if(syncNowRunning(s.syncNow))void pollEbaySync();
     return s;
   }catch(e){setEbayError(errText(e));return null;}
 },[accessToken,pollEbaySync]);
 async function startEbaySync(extra:Record<string,unknown>={}){
   setBusy(true);setError('');
   try{
     const data=await ebayCall(accessToken,'sync_now',extra);
     setEbay(data);
     setNotice(data.message||data.syncNow?.progress?.message||'eBay sync started…');
     if(data.started||data.alreadyRunning||syncNowRunning(data.syncNow))void pollEbaySync();
     else setNotice(formatSyncNotice(data.syncNow));
   }catch(e){setError(errText(e));}
   finally{setBusy(false);}
 }
 async function load(){setError('');try{const [a,b,c,ch]=await Promise.all([client.rpc('portal_marketplace_inventory'),client.rpc('portal_marketplace_email_sales'),client.rpc('portal_marketplace_delists'),client.rpc('portal_marketplace_channels')]);for(const x of [a,b,c,ch])if(x.error)throw x.error;setInv(a.data||[]);setReview((b.data||[]).filter((x:Review)=>x.state==='needs_review'));setIgnored((b.data||[]).filter((x:Review)=>x.state==='ignored'&&(x.marketplace==='depop'||x.marketplace==='mercari')).slice(0,30));setDelists(c.data||[]);const cleaned=((ch.data||defaultChannels) as Channel[]).filter(x=>x.key!=='vendoo');setChannelOptions(cleaned);setChannelText(cleaned.map(x=>x.key+' | '+x.label+' | '+x.aliases.join(', ')).join('\n'));await loadEbay();}catch(e){setError(errText(e));}}
 useEffect(()=>{void load();},[]);
 async function listed(u:Inv,channel:string,checked:boolean){setBusy(true);try{const next=checked?[...new Set([...(u.listed_on||[]),channel])]:u.listed_on.filter(x=>x!==channel);const {error:e}=await client.rpc('portal_set_unit_listed_on',{p_sku:u.sku,p_channels:next});if(e)throw e;setNotice(`SKU ${u.sku} listing status saved.`);await load();}catch(e){setError(errText(e));}finally{setBusy(false);}}
 async function sell(payload:Record<string,unknown>){setBusy(true);setError('');try{const res=await fetch(floorFunctionUrl('marketplace-sale'),{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'content-type':'application/json'},body:JSON.stringify(payload)});const body=await res.json();if(!res.ok)throw new Error(body.error||`Request failed ${res.status}`);setNotice(`Sale recorded for SKU ${String(payload.sku)}. Floor will delist it from the website and other channels.`);setSale(null);setReviewEdit(null);await load();}catch(e){setError(errText(e));}finally{setBusy(false);}}
 async function rescanInbox(){setBusy(true);setError('');try{const res=await fetch(floorFunctionUrl('gmail-sales-poll'),{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'content-type':'application/json'},body:JSON.stringify({action:'rescan_inbox',include_seen:true})});const body=await res.json().catch(()=>({}));if(!res.ok)throw new Error(body.error||`Inbox rescan failed (${res.status})`);if(body.skipped)throw new Error(String(body.skipped));const matched=Number(body.matched||0),reviewN=Number(body.needs_review||0),ignoredN=Number(body.ignored||0),found=Number(body.found||0);setNotice(`Inbox rescan finished · found ${found} · matched ${matched} · review ${reviewN} · ignored ${ignoredN}. Check Live Sales / Orders / Review below.`);await load();}catch(e){setError(errText(e));}finally{setBusy(false);}}
 async function done(id:number){setBusy(true);try{const {error:e}=await client.rpc('portal_complete_marketplace_delist',{p_id:id});if(e)throw e;await load();}catch(e){setError(errText(e));}finally{setBusy(false);}}
 async function saveChannels(){setBusy(true);setError('');try{const rows=channelText.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).map(line=>{const [key,label,aliases='']=line.split('|').map(x=>x.trim());return{key:key.toLowerCase(),label,aliases:aliases.split(',').map(x=>x.trim()).filter(Boolean)}}).filter(r=>r.key&&r.key!=='vendoo');if(!rows.length)throw new Error('Keep at least one marketplace.');const {error:e}=await client.rpc('portal_set_online_setting',{p_key:'marketplace_channels',p_value:rows});if(e)throw e;setNotice('Marketplace list saved.');await load();}catch(e){setError(errText(e));}finally{setBusy(false);}}
 const channelLabel=(key:string)=>channelOptions.find(x=>x.key===key)?.label||key;
 const counts=useMemo(()=>({listed:inv.filter(x=>x.listed_on?.length).length,review:review.length}),[inv,review]);
 const accounts=ebay?.accounts||[];
 const selling=ebay?.sellingAccount||null;
 const personal=ebay?.ordersOnlyAccount||null;
 const migration=ebay?.migration;
 const latestItems=(dryRun?.items||migration?.latest?.items||[]) as MigrationItem[];
 const latestSummary=dryRun?.summary||(migration?.latest?.run?.summary as Record<string,number>|undefined);

 return <><header><div><div className="eyebrow">SALES CHANNELS</div><h1>Marketplaces</h1><p>Connections, sync status, sale-email review, and delist reminders. List / add / edit / end from the eBay, Amazon, TikTok, and Depop sidebar tabs. Mercari sale emails still ingest for history.</p></div><div className="actions"><button className="secondary" disabled={busy} onClick={()=>void load()}>Refresh</button><button disabled={busy} onClick={()=>{if(window.confirm('Re-scan the Depop/Mercari sale-email inbox (including already-read mail)? Historical Mercari sales still ingest; Mercari is not a live listing target.'))void rescanInbox();}}>Re-scan sale emails</button></div></header>
 {error&&<div className="alert" role="alert">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}{notice&&<div className="hint">{notice}<button className="text-button" onClick={()=>setNotice('')}>Dismiss</button></div>}
 <div className="stats"><div className="stat"><span>Units listed elsewhere</span><strong>{counts.listed}</strong></div><div className="stat"><span>Sales to review</span><strong>{counts.review}</strong></div><div className="stat"><span>Delist reminders</span><strong>{delists.length}</strong></div></div>

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
      {a.role==='selling' && a.status==='connected' && !a.policiesReady && <button disabled={busy} onClick={()=>void (async()=>{setBusy(true);setError('');try{await ebayCall(accessToken,'ensure_policies',{account_id:a.id});setNotice('Business policies created on the selling account.');await loadEbay();}catch(e){setError(errText(e));}finally{setBusy(false);}})()}>Create business policies</button>}
      {a.status==='connected' && <button className="secondary" disabled={busy||syncPolling} onClick={()=>void startEbaySync({account_id:a.id})}>Sync orders</button>}
      {a.status==='connected' && <button className="text-button danger" disabled={busy} onClick={()=>{if(!window.confirm(`Disconnect ${a.username}?`))return;void (async()=>{setBusy(true);try{setEbay(await ebayCall(accessToken,'disconnect',{account_id:a.id}));setNotice(`${a.username} disconnected.`);}catch(e){setError(errText(e));}finally{setBusy(false);}})();}}>Disconnect</button>}
     </div>
   </div>)}</div>}
   <div className="actions" style={{marginTop:'1rem'}}>
    {!selling && <button disabled={busy} onClick={()=>void (async()=>{setBusy(true);setError('');try{const data=await ebayCall(accessToken,'connect_selling');if(data.url)window.location.href=data.url;}catch(e){setError(errText(e));}finally{setBusy(false);}})()}>Connect selling account</button>}
    {!selling && <p className="hint">Opens eBay with a fresh login. Sign into the <strong>business</strong> seller — if you see {ebay?.requiredUsername || 'pgg124-5'}, use Switch accounts / Not you before approving.</p>}
    {!personal && <button className="secondary" disabled={busy} onClick={()=>void (async()=>{setBusy(true);setError('');try{const data=await ebayCall(accessToken,'connect_orders_only');if(data.url)window.location.href=data.url;}catch(e){setError(errText(e));}finally{setBusy(false);}})()}>Connect {ebay?.requiredUsername || 'pgg124-5'} (orders only)</button>}
    {ebay?.connected && <button className="secondary" disabled={busy||syncPolling} onClick={()=>void startEbaySync()}>Sync all accounts now</button>}
   </div>
   {ebay?.syncNow && <div className="ticket" style={{marginTop:'1rem'}}>
     <div className="ticket-top">
       <strong>Manual sync · {ebay.syncNow.status||'unknown'}</strong>
       <span>{ebay.syncNow.progress?.current!=null&&ebay.syncNow.progress?.total!=null?`${ebay.syncNow.progress.current}/${ebay.syncNow.progress.total}`:''}{syncPolling?' · updating…':''}</span>
     </div>
     <p className="hint" style={{margin:'6px 0'}}>{ebay.syncNow.progress?.message||ebay.syncNow.error||'No progress yet.'}</p>
     {ebay.syncNow.summary && <p><strong>Result:</strong> {ebay.syncNow.summary.ok_accounts??0}/{ebay.syncNow.summary.accounts??0} account(s) ok · {ebay.syncNow.summary.results??0} result(s){ebay.syncNow.summary.failed_accounts?` · ${ebay.syncNow.summary.failed_accounts} failed`:''}</p>}
     {(ebay.syncNow.account_results||[]).length>0 && <div className="ticket-list">{(ebay.syncNow.account_results||[]).map((r,i)=><div className="ticket" key={`${r.username||i}`}>
       <strong>{r.ok===false?'Error':'OK'} · {r.username||'account'}{r.role?` (${r.role})`:''}</strong>
       <small>{r.result_count??0} result(s){r.matched!=null?` · matched ${r.matched}`:''}{r.skipped!=null?` · skipped ${r.skipped}`:''}{(r.errors&&r.errors[0])?` · ${r.errors[0]}`:''}</small>
     </div>)}</div>}
     {ebay.syncNow.error && ebay.syncNow.status==='error' && <p className="alert" role="alert">{ebay.syncNow.error}</p>}
     <div className="actions">
       <button className="text-button" disabled={busy||syncPolling} onClick={()=>void (async()=>{setBusy(true);try{const s=await ebayCall(accessToken,'sync_latest');setEbay(s);if(!syncNowRunning(s.syncNow))setNotice(formatSyncNotice(s.syncNow));}catch(e){setError(errText(e));}finally{setBusy(false);}})()}>Refresh sync status</button>
     </div>
   </div>}
   {selling && !selling.policiesReady && <p className="hint">After connecting the business account, create its business policies (calculated shipping buyer-pays, no returns, payment). No local pickup.</p>}
   {ebay?.lastError && <p className="hint">Last sync error: {ebay.lastError}</p>}
  </>}
 </section>

 <section className="panel"><h2>eBay listing migration</h2>
  <p>Move every active store listing off {ebay?.requiredUsername || 'pgg124-5'} onto the business selling account. One listing at a time: end on source, create on destination at the same price, confirm live, update Floor. Open orders stay on {ebay?.requiredUsername || 'pgg124-5'}.</p>
  {migration?.blockers?.length ? <div className="alert" role="status">{migration.blockers.map(b=><div key={b}>{b}</div>)}</div> : <p className="hint">Prerequisites met{selling ? ` · selling: ${selling.username}` : ''}{personal ? ` · source: ${personal.username}` : ''}.</p>}
  <div className="actions">
   <button className="secondary" disabled={busy||!personal} onClick={()=>void (async()=>{setBusy(true);setError('');try{const data=await ebayCall(accessToken,'migration_dry_run');if(data.started){setNotice(data.message||'Dry-run started in the background…');for(let i=0;i<36;i++){await new Promise(r=>setTimeout(r,5000));const latest=await ebayCall(accessToken,'migration_latest');const run=latest.latest?.run as {status?:string;summary?:Record<string,number>;mode?:string}|undefined;const items=latest.latest?.items||[];if(run&&run.status!=='running'){setDryRun({summary:run.summary,items,blockers:data.blockers,message:data.message});setNotice(`Dry-run finished · ${(run.summary?.will_move??0)} will move · ${(run.summary?.skipped??0)} skipped · ${(run.summary?.failed??0)} failed · total ${(run.summary?.total??items.length)}.`);await loadEbay();return;}if(i===0||i%3===0)setNotice(`Dry-run running… ${items.length} listing(s) scored so far.`);}setNotice('Dry-run still running — hit Load latest results in a minute.');await loadEbay();return;}setDryRun({summary:data.summary,items:data.items,blockers:data.blockers,message:data.message});setNotice(data.message||`Dry-run finished · ${(data.summary?.will_move??0)} will move · ${(data.summary?.skipped??0)} skipped · ${(data.summary?.failed??0)} failed.`);await loadEbay();}catch(e){setError(errText(e));}finally{setBusy(false);}})()}>Dry-run migration</button>
   <button disabled={busy||!(migration?.ready||ebay?.migrationReady)} onClick={()=>{if(!window.confirm('Run the live migration now? Listings will be ended on the personal account and recreated on the business account one at a time. Open orders are skipped.'))return;void (async()=>{setBusy(true);setError('');try{const data=await ebayCall(accessToken,'migration_run');setNotice(data.message||'Migration started in the background.');await loadEbay();}catch(e){setError(errText(e));}finally{setBusy(false);}})();}}>Run migration</button>
   <button className="text-button" disabled={busy} onClick={()=>void (async()=>{setBusy(true);try{const data=await ebayCall(accessToken,'migration_latest');setEbay(await ebayCall(accessToken,'status'));if(data.latest){const summary=(data.latest.run?.summary||{}) as Record<string,number>;setDryRun({summary,items:data.latest.items});setNotice(`Loaded latest · will move ${summary.will_move??0} · skipped ${summary.skipped??0} · failed ${summary.failed??0} · moved ${summary.moved??0} · total ${summary.total??data.latest.items?.length??0}.`);}else setNotice('No migration runs yet.');}catch(e){setError(errText(e));}finally{setBusy(false);}})()}>Load latest results</button>
  </div>
  {latestSummary && <p><strong>Summary:</strong> will move {latestSummary.will_move??0} · moved {latestSummary.moved??0} · skipped {latestSummary.skipped??0} · failed {latestSummary.failed??0} · total {latestSummary.total??latestItems.length}</p>}
  {latestItems.length>0 && <div className="ticket-list">{latestItems.slice(0,200).map((item,i)=>{
    const id=item.source_item_id||item.sourceItemId||String(i);
    const price=item.price_cents??item.priceCents;
    return <div className="ticket" key={id}><strong>{outcomeLabel(item.outcome)} · {item.title||id}</strong><small>Item {id}{item.sku?` · SKU ${item.sku}`:''}{price!=null?` · ${money(price)}`:''}{item.dest_item_id||item.destItemId?` → ${item.dest_item_id||item.destItemId}`:''}{item.reason?` · ${item.reason}`:''}</small></div>;
  })}{latestItems.length>200 && <p className="hint">Showing first 200 of {latestItems.length}.</p>}</div>}
  {!latestItems.length && <div className="empty">No dry-run or migration results yet. Connect both accounts, create policies, then run a dry-run.</div>}
 </section>

 <TikTokShopPanel client={client} accessToken={accessToken} money={money} connectionOnly />

 <section className="panel"><h2>Marketplace sales</h2><p>Sale emails with an exact SKU and price are processed automatically. Unmatched emails wait here; confirm SKU and price before Floor marks anything sold.</p>{review.length===0?<div className="empty">No emails waiting for review.</div>:<div className="ticket-list">{review.map(r=><div className="ticket" key={r.id}><strong>{r.marketplace||'Marketplace'} — {r.item_title||r.subject}</strong><small>{r.reason||'Needs review'} — Order {r.order_number||'unknown'} — {r.ship_by?`Ship by ${r.ship_by}`:'No ship-by date'}</small>{reviewEdit?.row.id===r.id?<div className="actions"><input aria-label="SKU" inputMode="numeric" value={reviewEdit.sku} onChange={e=>setReviewEdit({...reviewEdit,sku:e.target.value})} placeholder="Exact Floor SKU"/><select value={reviewEdit.channel} onChange={e=>setReviewEdit({...reviewEdit,channel:e.target.value})}>{channels.map(x=><option key={x}>{x}</option>)}</select><input aria-label="Sale price" type="number" min="0.01" step="0.01" value={reviewEdit.price} onChange={e=>setReviewEdit({...reviewEdit,price:e.target.value})}/><button disabled={busy} onClick={()=>void sell({action:'approve_review',review_id:r.id,sku:reviewEdit.sku,channel:reviewEdit.channel,price_cents:Math.round(Number(reviewEdit.price)*100)})}>Confirm sale</button><button className="secondary" onClick={()=>setReviewEdit(null)}>Cancel</button></div>:<button className="secondary" onClick={()=>setReviewEdit({row:r,sku:r.sku||'',channel:r.marketplace||'depop',price:r.sale_price_cents==null?'':(r.sale_price_cents/100).toFixed(2)})}>Review & match</button>}</div>)}</div>}</section>
 <section className="panel"><h2>Recently ignored Depop / Mercari mail</h2><p>These were read from the inbox but not treated as sales. After a parser fix, use <strong>Re-scan sale emails</strong> above — ignored Message-IDs are re-evaluated. Or use <strong>Mark sold</strong> on the unit below to record today&apos;s sale manually (delists everywhere, lands in Live Sales + Orders).</p>{ignored.length===0?<div className="empty">No recent ignored Depop/Mercari emails.</div>:<div className="ticket-list">{ignored.map(r=><div className="ticket" key={r.id}><strong>{r.marketplace||'Marketplace'} · {r.subject||r.item_title||'Email'}</strong><small>{r.reason||'Ignored'}{r.sku?` · SKU ${r.sku}`:''}{r.sale_price_cents!=null?` · ${money(r.sale_price_cents)}`:''} · {stamp?stamp(r.created_at):r.created_at}</small></div>)}</div>}</section>
 <section className="panel"><h2>Units and listing status</h2><p>Checklist for eBay / Amazon / TikTok / Facebook. Depop is not a checkbox — use the Depop sidebar tab → Push to Depop (a unit only counts as on Depop when a listing row exists). “Mark sold” is a manual fallback.</p><div className="ticket-list">{inv.map(u=><div className="ticket" key={u.sku}><div className="ticket-top"><strong>{u.title||`SKU ${u.sku}`}</strong><span>SKU {u.sku} — {u.state} — {u.ask_cents==null?'No price':money(u.ask_cents)}{(u.listed_on||[]).includes('depop')?' · Depop (listing row)':''}</span></div><div className="actions">{CHECKLIST_CHANNELS.filter(c=>channels.includes(c)).map(c=><label key={c}><input type="checkbox" checked={u.listed_on?.includes(c)} disabled={busy} onChange={e=>void listed(u,c,e.target.checked)}/> {channelLabel(c)}</label>)}{u.state==='available'&&<button className="text-button danger" onClick={()=>setSale({sku:u.sku,channel:(u.listed_on||[]).includes('depop')?'depop':(u.listed_on||[]).includes('ebay')?'ebay':(u.listed_on?.[0]||'depop'),price:(u.ask_cents?u.ask_cents/100:0).toFixed(2),order:'',fulfillment:'ship'})}>Mark sold</button>}</div><MarketplacePrices sku={u.sku} accessToken={accessToken} client={client} money={money}/></div>)}</div></section>
 <section className="panel"><h2>Marketplace list</h2><p>One marketplace per line: key | display name | email keywords. Powers sold-on choices, email matching, delist alerts, and reports. Keep Mercari for historical sale emails if needed.</p><label className="notes">Channels<textarea rows={12} value={channelText} onChange={e=>setChannelText(e.target.value)}/></label><button disabled={busy} onClick={()=>void saveChannels()}>Save marketplace list</button></section>
 <section className="panel"><h2>Delist reminders</h2>{delists.length===0?<div className="empty">No open reminders.</div>:<div className="ticket-list">{delists.map(d=><div className="ticket ticket-top" key={d.id}><strong>SKU {d.sku} sold — delist in {d.channel}</strong><button disabled={busy} onClick={()=>void done(d.id)}>Done</button></div>)}</div>}</section>
 {sale&&<div className="modal-backdrop"><form className="panel modal" onSubmit={e=>{e.preventDefault();const cents=Math.round(Number(sale.price)*100);if(cents>0&&window.confirm(`Record SKU ${sale.sku} sold on ${channelLabel(sale.channel)} for ${money(cents)}? This marks it sold in Floor.`))void sell({sku:sale.sku,channel:sale.channel,price_cents:cents,order_number:sale.order,fulfillment:sale.fulfillment});}}><h2>Record marketplace sale — SKU {sale.sku}</h2><label>Marketplace<select value={sale.channel} onChange={e=>setSale({...sale,channel:e.target.value})}>{channels.map(x=><option key={x}>{x}</option>)}</select></label><label>Sale price ($)<input required type="number" min="0.01" step="0.01" value={sale.price} onChange={e=>setSale({...sale,price:e.target.value})}/></label><label>Order number<input value={sale.order} onChange={e=>setSale({...sale,order:e.target.value})}/></label><label>Fulfillment<select value={sale.fulfillment} onChange={e=>setSale({...sale,fulfillment:e.target.value})}><option value="ship">To ship</option><option value="pickup">Pickup</option></select></label><div className="actions"><button disabled={busy}>Confirm sold</button><button type="button" className="secondary" onClick={()=>setSale(null)}>Cancel</button></div></form></div>}
 </>;
}
