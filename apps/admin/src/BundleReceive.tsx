import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatCents, parseMoneyToCents } from '@floor/store';
import { floorFunctionUrl } from './floorApi';

type Pick = { sku: string; title: string; ask_cents: number; qty_on_hand: number; quantity: number };

export function BundleReceive({ client, lastReceived, onSaved }: {
  client: SupabaseClient; lastReceived?: string; onSaved: () => void;
}) {
  const [mainSku, setMainSku] = useState('');
  const [extraSku, setExtraSku] = useState('');
  const [extraQty, setExtraQty] = useState(1);
  const [main, setMain] = useState<Pick | null>(null);
  const [extras, setExtras] = useState<Pick[]>([]);
  const [override, setOverride] = useState('');
  const [bundleSku, setBundleSku] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function load(sku: string): Promise<Pick> {
    const { data, error } = await client.from('units').select('sku,title,ask_cents,qty_on_hand,state')
      .eq('sku', sku.trim()).maybeSingle();
    if (error) throw error;
    if (!data || data.state !== 'available' || data.ask_cents == null || data.qty_on_hand < 1) {
      throw new Error(`SKU ${sku} is not available with a price.`);
    }
    return { sku: data.sku, title: data.title, ask_cents: data.ask_cents,
      qty_on_hand: data.qty_on_hand, quantity: 1 };
  }

  async function chooseMain(sku: string) {
    setBusy(true); setMessage('');
    try { setMain(await load(sku)); setMainSku(sku.trim()); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function addExtra() {
    setBusy(true); setMessage('');
    try {
      const item = await load(extraSku);
      if (item.sku === main?.sku || extras.some(e => e.sku === item.sku)) throw new Error('Choose a different SKU.');
      if (extraQty < 1 || extraQty > item.qty_on_hand) throw new Error('Quantity exceeds available stock.');
      setExtras(rows => [...rows, { ...item, quantity: extraQty }]);
      setExtraSku(''); setExtraQty(1);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  const autoPrice = main ? main.ask_cents + Math.round(extras.reduce((n, e) => n + e.ask_cents * e.quantity, 0) / 2) : null;
  const overrideCents = override.trim() ? parseMoneyToCents(override) : null;

  async function endLiveListings(sku: string) {
    const { data: listed, error: listError } = await client.from('listings')
      .select('channel,offer_id,ebay_account_id,listing_id')
      .eq('sku', sku).eq('status', 'listed');
    if (listError) throw listError;
    const channels = new Map<string, Record<string, unknown>>((listed ?? []).filter(row => row.channel !== 'website')
      .map(row => [row.channel, row]));
    const { data: amazon, error: amazonError } = await client.from('amazon_list_items')
      .select('status,offer_sku').eq('sku', sku).maybeSingle();
    if (amazonError) throw amazonError;
    if (amazon && ['live', 'listed'].includes(amazon.status)) channels.set('amazon', { channel: 'amazon', offer_sku: amazon.offer_sku });
    const { data: tiktok, error: tiktokError } = await client.from('tiktok_list_items')
      .select('status,product_id').eq('sku', sku).maybeSingle();
    if (tiktokError) throw tiktokError;
    if (tiktok && ['live', 'listed'].includes(tiktok.status)) channels.set('tiktok', { channel: 'tiktok', product_id: tiktok.product_id });
    if (channels.has('depop')) throw new Error(`Remove SKU ${sku} from Depop manually, then mark its Floor listing ended.`);
    const { data: session } = await client.auth.getSession();
    for (const [channel, row] of channels) {
      const payload = {
        action: 'end', channel, sku,
        offer_id: 'offer_id' in row ? row.offer_id : null,
        account_id: 'ebay_account_id' in row ? row.ebay_account_id : null,
        offer_sku: 'offer_sku' in row ? row.offer_sku : null,
        product_id: 'product_id' in row ? row.product_id : null,
      };
      const response = await fetch(floorFunctionUrl('listing-manager'), {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          Authorization: `Bearer ${session.session?.access_token || ''}` },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(`${channel} delist failed: ${result.error || result.message || response.status}`);
    }
  }

  async function create() {
    if (!main || !extras.length) return;
    if (override.trim() && overrideCents == null) { setMessage('Enter a valid override price.'); return; }
    setBusy(true); setMessage('');
    try {
      const params = {
        p_main: main.sku,
        p_extras: extras.map(e => ({ sku: e.sku, quantity: e.quantity })),
        p_override_cents: overrideCents,
      };
      let { data, error } = await client.rpc('portal_create_bundle', params);
      if (error?.message.includes('delist_component_first')) {
        for (const sku of [main.sku, ...extras.map(e => e.sku)]) await endLiveListings(sku);
        ({ data, error } = await client.rpc('portal_create_bundle', params));
      }
      if (error) throw error;
      setBundleSku(String(data));
      setMessage(`Bundle ${data} created. Add photos to its SKU before listing online.`);
      setMain(null); setMainSku(''); setExtras([]); setOverride(''); onSaved();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function unbundle() {
    if (!bundleSku.trim()) return;
    setBusy(true); setMessage('');
    try {
      await endLiveListings(bundleSku.trim());
      const { error } = await client.rpc('portal_unbundle', { p_bundle: bundleSku.trim() });
      if (error) throw error;
      setMessage(`Bundle ${bundleSku} released. Components can be listed again.`);
      setBundleSku(''); onSaved();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function saveOverride() {
    if (!bundleSku.trim()) return;
    if (override.trim() && overrideCents == null) { setMessage('Enter a valid override price.'); return; }
    setBusy(true); setMessage('');
    try {
      const { error } = await client.rpc('portal_set_bundle_price', {
        p_bundle: bundleSku.trim(), p_override_cents: overrideCents,
      });
      if (error) throw error;
      setMessage(overrideCents == null ? 'Automatic pricing restored.' : `Bundle ${bundleSku} price set to ${formatCents(overrideCents)}.`);
      onSaved();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <details className="panel bundle-receive">
    <summary>Bundle items</summary>
    <p>Attach stocked items to a main SKU. The bundle gets its own SKU; components keep theirs.</p>
    <label>Main SKU
      <input value={mainSku} onChange={e => setMainSku(e.target.value)} inputMode="numeric" />
    </label>
    <div className="actions">
      <button type="button" disabled={busy || !mainSku.trim()} onClick={() => void chooseMain(mainSku)}>Choose main</button>
      {lastReceived && <button type="button" className="secondary" disabled={busy} onClick={() => void chooseMain(lastReceived)}>Use received {lastReceived}</button>}
    </div>
    {main && <p>{main.sku} · {main.title} · {formatCents(main.ask_cents)} · {main.qty_on_hand} available</p>}
    <label>Included SKU
      <input value={extraSku} onChange={e => setExtraSku(e.target.value)} inputMode="numeric" />
    </label>
    <label>Quantity per bundle
      <input type="number" min="1" step="1" value={extraQty} onChange={e => setExtraQty(Number(e.target.value))} />
    </label>
    <button type="button" className="secondary" disabled={busy || !extraSku.trim()} onClick={() => void addExtra()}>Add included item</button>
    {extras.map(e => <p key={e.sku}>{e.quantity} × {e.title} · {e.sku} <button type="button" className="text-button" onClick={() => setExtras(rows => rows.filter(x => x.sku !== e.sku))}>Remove</button></p>)}
    {autoPrice != null && <p>Automatic price: <strong>{formatCents(autoPrice)}</strong></p>}
    <label>Override price (optional)
      <input inputMode="decimal" value={override} onChange={e => setOverride(e.target.value)} placeholder="Use automatic price" />
    </label>
    <div className="actions">
      <button type="button" disabled={busy || !main || !extras.length} onClick={() => void create()}>Create bundle</button>
    </div>
    <label>Bundle SKU to unbundle
      <input value={bundleSku} onChange={e => setBundleSku(e.target.value)} inputMode="numeric" />
    </label>
    <button type="button" className="secondary" disabled={busy || !bundleSku.trim()} onClick={() => void saveOverride()}>Update this bundle’s price</button>
    <button type="button" className="secondary" disabled={busy || !bundleSku.trim()} onClick={() => void unbundle()}>Delist and unbundle</button>
    {message && <p role="status">{message}</p>}
  </details>;
}
