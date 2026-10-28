import { ToolCard, ToolHeading, ToolIcon, ToolEmpty, ToolTip } from './design/Tools';
import { scannerInputMode } from './kiosk';
import { scanBarcode } from './barcodeCamera';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import bwipjs from 'bwip-js/browser';

type Bay = { bay_no: number; row_bins: number[] };
type Location = { code: string; bay_no: number; row_no: number; bin_no: number | null; stock: number };
type Allocation = { sku: string; location_code: string; quantity: number };
type LocationMove = { sku: string; from_location: string | null; to_location: string; quantity: number; moved_at: string };
type Props = { client: SupabaseClient; storeId: string; canManage?: boolean };
const number = (raw: string) => Number(raw.trim());

function Barcode({ code }: { code: string }) {
  const svg = useMemo(() => bwipjs.toSVG({
    bcid: 'code128', text: code, scale: 2, height: 12,
    includetext: false, paddingwidth: 8, paddingheight: 2,
  }), [code]);
  return <div className="location-barcode" aria-label={`Barcode for ${code}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function LocationsPage({ client, storeId, canManage = true }: Props) {
  const [view, setView] = useState<'overview'|'setup'|'move'|'assign'>('overview');
  const [loaded, setLoaded] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const submitLock = useRef(false);
  const skuVersion = useRef(0);
  const [bays, setBays] = useState<Bay[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [recentMoves, setRecentMoves] = useState<LocationMove[]>([]);
  const [bay, setBay] = useState('');
  const [rows, setRows] = useState<string[]>(['3', '3', '3']);
  const [sku, setSku] = useState('');
  const [to, setTo] = useState('');
  const [assignBin, setAssignBin] = useState(() => { try { return localStorage.getItem('floor:assign-location-bin') || ''; } catch { return ''; } });
  const [from, setFrom] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [printBay, setPrintBay] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const toInput = useRef<HTMLInputElement>(null);
  const skuInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const { data, error: rpcError } = await client.rpc('portal_bay_list');
    if (rpcError) throw rpcError;
    setBays((data?.bays || []) as Bay[]);
    setLocations((data?.locations || []) as Location[]);
    const moves = await client.from('unit_location_moves').select('sku,from_location,to_location,quantity,moved_at')
      .eq('store_id',storeId).order('moved_at',{ascending:false}).limit(12);
    if (moves.error) throw moves.error;
    setRecentMoves((moves.data || []) as LocationMove[]); setLoaded(true);
  }, [client]);
  useEffect(() => { void load().catch((e) => setError(String(e.message || e))); }, [load]);

  async function saveBay(event: FormEvent) {
    event.preventDefault(); if (submitLock.current) return; setError(''); setNotice('');
    const bayNo = number(bay), layout = rows.map(number);
    if (!Number.isInteger(bayNo) || bayNo < 1 || bayNo > 9999
      || layout.length < 3 || layout.length > 5 || layout.some((n) => !Number.isInteger(n) || n < 0 || n > 5)) {
      setError('Use bay 1–9999, three to five rows, and zero to five bins per row.'); return;
    }
    submitLock.current = true; setBusy(true);
    try {
      const { error: rpcError } = await client.rpc('portal_set_bay', { p_bay: bayNo, p_rows: layout });
      if (rpcError) throw rpcError;
      await load(); setView('overview'); setNotice(`Bay ${bayNo} saved.`);
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { submitLock.current = false; setBusy(false); }
  }

  async function loadSku(next: string) {
    const version = ++skuVersion.current; setSku(next); setAllocations([]); setFrom('');
    if (!next.trim()) return;
    const { data, error: queryError } = await client.from('unit_location_stock')
      .select('sku,location_code,quantity').eq('store_id', storeId).eq('sku', next.trim());
    if (version !== skuVersion.current) return;
    if (queryError) { setError(queryError.message); return; }
    setAllocations((data || []) as Allocation[]);
  }

  async function move(event: FormEvent) {
    event.preventDefault(); if (submitLock.current) return; setError(''); setNotice('');
    const qty = number(quantity), code = to.trim(), item = sku.trim();
    if (!Number.isInteger(qty) || qty < 1 || !locations.some((location) => location.code === code)) {
      setError('Scan a valid bay label and enter a positive whole quantity.'); return;
    }
    if (!item) { setError('Scan the item SKU.'); return; }
    if (from && qty > (allocations.find(a => a.location_code === from)?.quantity || 0)) { setError('Quantity exceeds the stock at the selected source location.'); return; }
    submitLock.current = true; setBusy(true);
    try {
      const { error: rpcError } = await client.rpc('portal_move_location_stock', {
        p_sku: item, p_to: code, p_quantity: qty, p_from: from || null,
      });
      if (rpcError) throw rpcError;
      setNotice(`${qty} × SKU ${item} placed at ${code}.`);
      await loadSku(item); await load();
      setSku(''); setFrom(''); setAllocations([]);
      skuInput.current?.focus();
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { submitLock.current = false; setBusy(false); }
  }

  async function camera(target: 'to'|'sku') {
    if (scanBusy) return; setScanBusy(true); setError('');
    try { const code = await scanBarcode();
      if (code) { if (target === 'to') {
        const value=code.trim();
        if(view==='assign'){setAssignBin(value);try{localStorage.setItem('floor:assign-location-bin',value);}catch{/* optional */}}
        else setTo(value);
        skuInput.current?.focus();
      } else await loadSku(code.trim()); }
      else { setNotice('Use your barcode scanner or type the label if camera scanning is unavailable.'); (target === 'to' ? toInput : skuInput).current?.focus(); }
    } finally { setScanBusy(false); }
  }
  const printed = locations.filter((location) => location.bay_no === printBay);
  const changeView = (next: 'overview'|'setup'|'move'|'assign') => { setView(next); setError(''); setNotice(''); };
  const createBay = () => { setBay(''); setRows(['3','3','3']); changeView('setup'); };
  const resizeRows = (count: number) => setRows(old => Array.from({ length: count }, (_, index) => old[index] ?? '0'));
  return <div className="floor-tools locations-page">
    {view !== 'overview' && <button type="button" className="tool-back" disabled={busy} onClick={() => changeView('overview')}>‹ Locations</button>}
    <header><div><h1>{view === 'setup' ? 'Bay setup' : view === 'move' ? 'Put away or move' : view === 'assign' ? 'Assign locations' : 'Locations'}</h1><p>{view === 'overview' ? 'Manage your storage bays and locations.' : view === 'setup' ? 'Configure the rows and bins for this bay.' : view === 'assign' ? 'Scan a bin once, then scan each item. Every assignment is saved immediately.' : 'Scan a location, then scan the items to put away.'}</p></div></header>
    {error && <div className="alert" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {!loaded && <p role="status">{error ? 'Locations could not be loaded.' : 'Loading locations…'} {error && <button type="button" className="secondary" onClick={() => void load().catch(e => setError(String(e.message || e)))}>Retry</button>}</p>}
    {view === 'overview' && <>
      <div className="location-quick-links">
        {canManage && <button type="button" onClick={() => changeView('setup')}><span className="tool-icon-badge"><ToolIcon name="bay"/></span><span>Bay setup<small>Configure rows and bins for a bay.</small></span></button>}
        <button type="button" onClick={() => changeView('assign')}><span className="tool-icon-badge"><ToolIcon name="scan"/></span><span>Assign locations<small>Scan a bin, then items one after another.</small></span></button>
        <button type="button" onClick={() => changeView('move')}><span className="tool-icon-badge"><ToolIcon name="move"/></span><span>Put away or move<small>Move inventory to a bay location.</small></span></button>
      </div>
      <ToolCard><ToolHeading icon="bay" title="Bays" description="Organize rows, bins and large-item storage." action={canManage && <button type="button" disabled={busy || !loaded} onClick={createBay}><ToolIcon name="plus"/>Create bay</button>}/>
        {loaded && bays.length === 0 ? <ToolEmpty icon="bay" title="No bays set up yet"><p>Create your first bay to organize rows and bins for storing inventory.</p>{canManage && <button type="button" onClick={createBay}><ToolIcon name="plus"/>Create bay</button>}</ToolEmpty> : <div className="location-bay-list">{bays.map(item => <details key={item.bay_no} className="location-bay">
          <summary><strong>Bay {item.bay_no}</strong><span>{locations.filter(l => l.bay_no === item.bay_no).reduce((n,l) => n+l.stock,0)} units · {item.row_bins.length} rows <span aria-hidden="true">›</span></span></summary>
          <div className="location-bay-body"><p className="location-row-summary">{item.row_bins.map((n,i) => `Row ${i+1}: ${n ? `${n} bins` : 'no bins / large items'}`).join(' · ')}</p><div className="location-code-list">
            {locations.filter(l => l.bay_no === item.bay_no).map(l => <span key={l.code}><b>{l.code}</b><small>{l.stock} units</small></span>)}
          </div><div className="actions">{canManage && <button type="button" className="secondary" onClick={() => { setBay(String(item.bay_no)); setRows(item.row_bins.map(String)); changeView('setup'); }}>Edit bay</button>}
            <button type="button" className="secondary" onClick={() => { setPrintBay(item.bay_no); setTimeout(() => window.print(),100); }}>Print bay labels</button></div></div>
        </details>)}</div>}
      </ToolCard>
      {recentMoves.length > 0 && <ToolCard><ToolHeading icon="move" title="Recent location history" description="Latest put-away and move events."/><div className="location-code-list">{recentMoves.map((move,index)=><span key={`${move.sku}-${move.moved_at}-${index}`}><b>SKU {move.sku} · {move.from_location || 'Unassigned'} → {move.to_location}</b><small>{new Date(move.moved_at).toLocaleString()}</small></span>)}</div></ToolCard>}
      <ToolTip>Each bay can have three to five rows. Each row supports up to five bins, or no bins for large items.</ToolTip>
    </>}
    {view === 'setup' && canManage && <><ToolCard><ToolHeading icon="bay" title="Bay setup" description="Configure the number of rows and bins for this bay location."/>
      <form className="location-bay-form" onSubmit={event => void saveBay(event)}>
        <label>Bay number<input required inputMode="numeric" value={bay} onChange={event => setBay(event.target.value)} placeholder="e.g. 14" disabled={busy}/></label>
        <div className="location-rows-head"><div><h2>Rows</h2><p>Set up three to five rows in this bay.</p></div><div className="tool-segment" aria-label="Number of rows">{[3,4,5].map(n => <button key={n} type="button" disabled={busy} aria-pressed={rows.length === n} onClick={() => resizeRows(n)}>{n} rows</button>)}</div></div>
        {rows.map((bins,index) => <label className="location-row-config" key={index}><span>Row {index+1}<ToolIcon name="bay"/></span><select disabled={busy} value={bins} onChange={event => setRows(old => old.map((value,i) => i === index ? event.target.value : value))}><option value="0">No bins · large items</option>{[1,2,3,4,5].map(count => <option key={count} value={count}>{count} {count === 1 ? 'bin' : 'bins'}</option>)}</select></label>)}
        <div className="actions"><button disabled={busy || !loaded}><ToolIcon name="save"/>{busy ? 'Saving…' : 'Save bay'}</button></div>
      </form></ToolCard><ToolTip>Choose no bins for a row that holds large items. Existing stock prevents unsafe layout changes.</ToolTip></>}
    {view === 'move' && <ToolCard><ToolHeading icon="move" title="Put away or move" description="Put away: scan a location, then scan item SKUs. To move assigned stock, scan the SKU, choose its current location, then scan the new label."/>
      <form className="location-scan-form" onSubmit={event => void move(event)}>
        <label>New location<small>Scan a location label</small><span className="location-scan-field"><input ref={toInput} required disabled={busy} inputMode={scannerInputMode()} value={to} onChange={event => setTo(event.target.value.trim())} onKeyDown={event => { if(event.key === 'Enter'){event.preventDefault();skuInput.current?.focus();} }} placeholder="Scan 14-2-3"/><button type="button" className="secondary" disabled={busy || scanBusy} aria-label="Scan location with camera" onClick={() => void camera('to')}><ToolIcon name="scan"/></button></span></label>
        <label>Item SKU<small>Scan item barcode</small><span className="location-scan-field"><input ref={skuInput} required disabled={busy} inputMode={scannerInputMode()} value={sku} onChange={event => void loadSku(event.target.value)} placeholder="Scan item barcode"/><button type="button" className="secondary" disabled={busy || scanBusy} aria-label="Scan item with camera" onClick={() => void camera('sku')}><ToolIcon name="scan"/></button></span></label>
        <label>Current location<small>Select the item’s current location</small><select disabled={busy} value={from} onChange={event => setFrom(event.target.value)}><option value="">Unassigned stock</option>{allocations.map(a => <option key={a.location_code} value={a.location_code}>{a.location_code} · {a.quantity} unit(s)</option>)}</select></label>
        <label>Quantity<small>Number of units to move</small><input disabled={busy} required inputMode="numeric" type="number" min="1" step="1" value={quantity} onChange={event => setQuantity(event.target.value)}/></label>
        <button className="tool-primary" disabled={busy || scanBusy || !loaded}><ToolIcon name="save"/>{busy ? 'Saving…' : scanBusy ? 'Scanning…' : 'Save location'}</button>
      </form></ToolCard>}
    {view === 'assign' && <ToolCard><ToolHeading icon="scan" title="Fast assign" description="Scan or choose a bin once. Then scan each SKU; successful assignments leave the No location list immediately."/>
      <form className="location-scan-form" onSubmit={event=>{event.preventDefault();void (async()=>{
        const item=sku.trim(), code=assignBin.trim(); if(!item||!locations.some(location=>location.code===code)){setError('Scan a configured bin first, then scan a SKU.');return;}
        if(submitLock.current)return;submitLock.current=true;setBusy(true);setError('');
        try{const result=await client.rpc('portal_move_location_stock',{p_sku:item,p_to:code,p_quantity:1,p_from:null});if(result.error)throw result.error;
          setNotice(`✓ SKU ${item} assigned to ${code}.`);setSku('');skuInput.current?.focus();await load();
        }catch(e){setError(String((e as Error).message||e));}finally{submitLock.current=false;setBusy(false);}
      })();}}>
        <label>Bin label<small>Scan once; retained for each item</small><span className="location-scan-field"><input ref={toInput} required disabled={busy} inputMode={scannerInputMode()} value={assignBin} onChange={event=>setAssignBin(event.target.value.trim())} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();const value=event.currentTarget.value.trim();if(locations.some(location=>location.code===value)){setAssignBin(value);try{localStorage.setItem('floor:assign-location-bin',value);}catch{/* optional */}skuInput.current?.focus();}else setError('That scan is not a configured location label.');}}} placeholder="12-2-3"/><button type="button" className="secondary" disabled={busy||scanBusy} onClick={()=>void camera('to')} aria-label="Scan bin label"><ToolIcon name="scan"/></button></span></label>
        <label>Item SKU<small>Scan one item; it saves immediately</small><input ref={skuInput} required disabled={busy} inputMode={scannerInputMode()} value={sku} onChange={event=>setSku(event.target.value.trim())} placeholder="Scan SKU" onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.form?.requestSubmit();}}}/></label>
        <button className="tool-primary" disabled={busy||!locations.some(location=>location.code===assignBin)}><ToolIcon name="save"/>{busy?'Saving…':'Assign this item'}</button>
      </form></ToolCard>}
    <div className="location-print-sheet" aria-hidden="true">{printed.map(location => <div className="location-label" key={location.code}><strong>Bay {location.bay_no} · R{location.row_no}{location.bin_no == null ? '' : `-B${location.bin_no}`}</strong><Barcode code={location.code}/></div>)}</div>
  </div>;
}
