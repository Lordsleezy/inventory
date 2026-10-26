import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';

type Row = { sku:string; title:string; price_cents:number|null; listing_url:string|null; listed_at:string|null; added_by:string|null; photo_path:string|null; unit_state:string; do_not_list:boolean; defective:boolean };
type Hit = { sku:string; title:string; photo_path:string|null; unit_state:string; do_not_list:boolean; defective:boolean };
const todayLA=()=>new Date().toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'});

export function DepopLiveListingsPanel({client,money,variant}:{client:SupabaseClient;money:(n:number)=>string;variant:'desktop'|'app'}) {
  const [rows,setRows]=useState<Row[]|null>(null),[search,setSearch]=useState(''),[query,setQuery]=useState(''),[hits,setHits]=useState<Hit[]>([]),[picked,setPicked]=useState<Hit|null>(null);
  const [url,setUrl]=useState(''),[price,setPrice]=useState(''),[day,setDay]=useState(todayLA()),[urls,setUrls]=useState<Record<string,string>>({});
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const load=useCallback(async()=>{const {data,error:e}=await client.rpc('portal_depop_live_listings');if(e){setError(e.message);return;}const list=(data||[]) as Row[];setRows(list);const paths=[...new Set(list.map(x=>x.photo_path).filter((x):x is string=>!!x&&/^[0-9a-f-]{36}\//i.test(x)))];if(paths.length){const {data:signed}=await client.storage.from('unit-photos').createSignedUrls(paths,3600);setUrls(Object.fromEntries((signed||[]).map((x,i)=>[paths[i],x.signedUrl||''])));}},[client]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{if(!query.trim()){setHits([]);return;}let live=true;const timer=setTimeout(()=>{void client.rpc('portal_depop_find_listing_units',{p_query:query.trim()}).then(({data})=>{if(live)setHits((data||[]) as Hit[]);});},250);return()=>{live=false;clearTimeout(timer);};},[client,query]);
  async function save(e:React.FormEvent){e.preventDefault();if(!picked)return;const cents=Math.round(Number(price)*100);if(!Number.isFinite(cents)||cents<0){setError('Enter a valid Depop price.');return;}setBusy(true);setError('');setNotice('');const {error:e2}=await client.rpc('portal_depop_add_listing',{p_sku:picked.sku,p_url:url.trim(),p_price_cents:cents,p_listed_at:day});setBusy(false);if(e2){setError(errText(e2));return;}setPicked(null);setQuery('');setUrl('');setPrice('');setDay(todayLA());setNotice(`SKU ${picked.sku} saved as live on Depop.`);await load();}
  async function remove(row:Row){if(!window.confirm(`Remove SKU ${row.sku} from the live Depop list? This does not change Floor inventory status.`))return;setBusy(true);const {error:e}=await client.rpc('portal_depop_remove_listing',{p_sku:row.sku});setBusy(false);if(e){setError(errText(e));return;}setNotice(`SKU ${row.sku} removed from the Depop list.`);await load();}
  const shown=(rows||[]).filter(r=>`${r.sku} ${r.title} ${r.listing_url||''}`.toLowerCase().includes(search.toLowerCase().trim()));
  const cls=variant==='app'?'depop-live depop-live-app':'depop-live';
  return <div className={cls}>
    <section className="panel"><div className="ticket-top"><h2>{rows===null?'Loading…':`${rows.length} live on Depop`}</h2></div>
      <form className="depop-form" onSubmit={e=>void save(e)}>
        <label>SKU (search or pick){picked?<div className="depop-picked"><strong>{picked.title}</strong><small>SKU {picked.sku}</small><button type="button" className="text-button" onClick={()=>setPicked(null)}>change</button></div>:<><input type="search" value={query} placeholder="SKU, brand, model or title" onChange={e=>setQuery(e.target.value)}/>{hits.length>0&&<div className="depop-hits">{hits.map(h=><button type="button" key={h.sku} onClick={()=>{setPicked(h);setHits([]);}}><strong>{h.title}</strong><small>SKU {h.sku} · {h.unit_state}{h.do_not_list?' · do not list':''}{h.defective?' · defective':''}</small></button>)}</div>}</>}</label>
        <label>Depop listing URL<input type="url" required value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://www.depop.com/products/..."/></label>
        <label>Depop price ($)<input inputMode="decimal" required value={price} onChange={e=>setPrice(e.target.value)} placeholder="0.00"/></label>
        <label>Date listed<input type="date" required max={todayLA()} value={day} onChange={e=>setDay(e.target.value)}/></label>
        <div className="actions"><button disabled={busy||!picked}>{busy?'Saving…':'Add listing'}</button></div>
      </form>{error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="hint" role="status">{notice}</p>}
    </section>
    <section className="panel"><h2>Live listings</h2><label>Search<input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="SKU, title, or Depop URL"/></label>
      {rows===null?<p className="hint">Loading…</p>:shown.length===0?<div className="empty">No matching Depop listings.</div>:<div className="ticket-list">{shown.map(r=>{const soldElsewhere=['sold','replaced','given_away'].includes(r.unit_state);const needsPull=soldElsewhere||r.do_not_list||r.defective;return <div className="ticket" key={r.sku}>
        <div className="depop-live-row">{r.photo_path&&urls[r.photo_path]?<img src={urls[r.photo_path]} alt=""/>:<div className="depop-live-placeholder">No photo</div>}<div className="depop-live-info"><div className="ticket-top"><strong>{r.title}</strong><span>{r.price_cents==null?'Price not entered':money(r.price_cents)}</span></div><small>SKU {r.sku} · listed {r.listed_at?.slice(0,10)||'date not entered'} · added by {r.added_by||'unknown'}</small>{r.listing_url&&<a href={r.listing_url} target="_blank" rel="noreferrer">Open Depop listing ↗</a>}{needsPull&&<strong className="depop-pull-alert">{soldElsewhere?'SOLD ELSEWHERE, pull from Depop':'DO NOT LIST, pull from Depop'}</strong>}</div></div>
        <div className="actions"><button type="button" className="secondary" disabled={busy} onClick={()=>void remove(r)}>Removed from Depop</button></div>
      </div>;})}</div>}
    </section>
  </div>;
}
