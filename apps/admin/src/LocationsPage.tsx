import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import bwipjs from 'bwip-js/browser';

type Bay = { bay_no: number; row_bins: number[] };
type Location = { code: string; bay_no: number; row_no: number; bin_no: number | null; stock: number };
type Allocation = { sku: string; location_code: string; quantity: number };
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
  const [bays, setBays] = useState<Bay[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [bay, setBay] = useState('');
  const [rows, setRows] = useState<string[]>(['3', '3', '3', '0']);
  const [sku, setSku] = useState('');
  const [to, setTo] = useState('');
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
  }, [client]);
  useEffect(() => { void load().catch((e) => setError(String(e.message || e))); }, [load]);

  async function saveBay(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice('');
    const bayNo = number(bay), layout = rows.map(number);
    if (!Number.isInteger(bayNo) || bayNo < 1 || bayNo > 9999
      || ![3, 4].includes(layout.length) || layout.some((n) => ![0, 2, 3].includes(n))) {
      setError('Use bay 1–9999, three or four rows, and 0, 2 or 3 bins per row.'); return;
    }
    setBusy(true);
    try {
      const { error: rpcError } = await client.rpc('portal_set_bay', { p_bay: bayNo, p_rows: layout });
      if (rpcError) throw rpcError;
      await load(); setNotice(`Bay ${bayNo} saved.`);
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); }
  }

  async function loadSku(next: string) {
    setSku(next); setAllocations([]);
    if (!next.trim()) return;
    const { data, error: queryError } = await client.from('unit_location_stock')
      .select('sku,location_code,quantity').eq('store_id', storeId).eq('sku', next.trim());
    if (queryError) { setError(queryError.message); return; }
    setAllocations((data || []) as Allocation[]);
  }

  async function move(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice('');
    const qty = number(quantity), code = to.trim(), item = sku.trim();
    if (!Number.isInteger(qty) || qty < 1 || !locations.some((location) => location.code === code)) {
      setError('Scan a valid bay label and enter a positive whole quantity.'); return;
    }
    if (!item) { setError('Scan the item SKU.'); return; }
    setBusy(true);
    try {
      const { error: rpcError } = await client.rpc('portal_move_location_stock', {
        p_sku: item, p_to: code, p_quantity: qty, p_from: from || null,
      });
      if (rpcError) throw rpcError;
      setNotice(`${qty} × SKU ${item} placed at ${code}.`);
      await loadSku(item); await load();
      setSku(''); setFrom('');
      skuInput.current?.focus();
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); }
  }

  const printed = locations.filter((location) => location.bay_no === printBay);
  return <div className="locations-page">
    <header><div><div className="eyebrow">WAREHOUSE</div><h1>Locations</h1>
      <p>Create bays, print labels, and scan units into a bay, row, or bin.</p></div></header>
    {error && <div className="alert" role="alert">{error}<button type="button" onClick={() => setError('')}>×</button></div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {canManage && <section className="panel"><h2>Bay setup</h2><form className="location-bay-form" onSubmit={(event) => void saveBay(event)}>
      <label>Bay number<input required inputMode="numeric" value={bay} onChange={(event) => setBay(event.target.value)} placeholder="14" /></label>
      {rows.map((bins, index) => <label key={index}>Row {index + 1}
        <select value={bins} onChange={(event) => setRows((old) => old.map((value, i) => i === index ? event.target.value : value))}>
          <option value="0">No bins · large items</option><option value="2">2 bins</option><option value="3">3 bins</option>
        </select></label>)}
      <div className="actions"><button disabled={busy}>Save bay</button>
        <button type="button" className="secondary" onClick={() => setRows((old) => old.length === 3 ? [...old, '0'] : old.slice(0, 3))}>{rows.length === 3 ? 'Add fourth row' : 'Use three rows'}</button></div>
    </form></section>}
    <section className="panel"><h2>Put away or move</h2>
      <p className="hint">Put away: scan a location, then scan item SKUs. To move assigned stock, scan the SKU, choose its current location, then scan the new label.</p>
      <form className="location-scan-form" onSubmit={(event) => void move(event)}>
        <label>New location<input ref={toInput} required value={to} onChange={(event) => setTo(event.target.value.trim())}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); skuInput.current?.focus(); } }} placeholder="Scan 14-2-3" /></label>
        <label>Item SKU<input ref={skuInput} required value={sku} onChange={(event) => void loadSku(event.target.value)}
          placeholder="Scan item barcode" /></label>
        <label>Current location<select value={from} onChange={(event) => setFrom(event.target.value)}>
          <option value="">Unassigned stock</option>
          {allocations.map((allocation) => <option key={allocation.location_code} value={allocation.location_code}>
            {allocation.location_code} · {allocation.quantity} unit(s)</option>)}
        </select></label>
        <label>Quantity<input inputMode="numeric" type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
        <button disabled={busy}>Save location</button>
      </form>
    </section>
    <section className="panel"><h2>Bays</h2>{bays.length === 0 ? <p className="empty">No bays set up yet.</p>
      : <div className="location-bay-list">{bays.map((item) => <details key={item.bay_no} className="location-bay">
        <summary><strong>Bay {item.bay_no}</strong><span>{locations.filter((location) => location.bay_no === item.bay_no).length} labels · {locations.filter((location) => location.bay_no === item.bay_no).reduce((n, location) => n + location.stock, 0)} units</span></summary>
        <div className="location-bay-body"><div className="location-code-list">
          {locations.filter((location) => location.bay_no === item.bay_no).map((location) => <span key={location.code}><b>{location.code}</b><small>{location.stock} unit(s)</small></span>)}
        </div><div className="actions">
          {canManage && <button type="button" className="secondary" onClick={() => { setBay(String(item.bay_no)); setRows(item.row_bins.map(String)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Edit bay</button>}
          <button type="button" className="secondary" onClick={() => { setPrintBay(item.bay_no); setTimeout(() => window.print(), 100); }}>Print bay labels</button>
        </div></div>
      </details>)}</div>}
    </section>
    <div className="location-print-sheet" aria-hidden="true">
      {printed.map((location) => <div className="location-label" key={location.code}>
        <strong>{location.code}</strong><Barcode code={location.code} />
      </div>)}
    </div>
  </div>;
}
