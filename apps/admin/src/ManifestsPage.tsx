import { ToolCard, ToolHeading, ToolIcon, ToolEmpty } from './design/Tools';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { countManifestFile } from './manifestCount';

type Manifest = {
  id: string; name: string; source: string; manifest_on: string; item_count: number;
  count_source: string; storage_path: string; received_count: number; sold_count: number;
  stock_count: number; revenue_cents: number; profit_cents: number;
};
type Props = { client: SupabaseClient; storeId: string; money: (cents: number) => string };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const ALLOWED = new Set(['pdf', 'csv', 'xlsx', 'png', 'jpg', 'jpeg', 'webp', 'heic']);

export function ManifestsPage({ client, storeId, money }: Props) {
  const submitLock = useRef(false);
  const fileVersion = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [counting, setCounting] = useState(false);
  const [rows, setRows] = useState<Manifest[]>([]);
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [date, setDate] = useState(today);
  const [file, setFile] = useState<File | null>(null);
  const [count, setCount] = useState('0');
  const [automatic, setAutomatic] = useState(false);
  const [bulk, setBulk] = useState('');
  const [bulkManifest, setBulkManifest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const { data, error: rpcError } = await client.rpc('portal_manifest_list');
    if (rpcError) throw rpcError;
    setRows((data || []) as Manifest[]); setLoaded(true);
  }, [client]);
  useEffect(() => { void load().catch((e) => setError(String(e.message || e))); }, [load]);
  const bulkSkus = useMemo(() => [...new Set(bulk.split(/[\s,;]+/).map(sku => sku.trim()).filter(Boolean))], [bulk]);
  const total = useMemo(() => rows.reduce((n, row) => n + row.item_count, 0), [rows]);

  async function chooseFile(next: File | null) {
    const version = ++fileVersion.current;
    setFile(next); setName((old) => old || next?.name.replace(/\.[^.]+$/, '') || '');
    setAutomatic(false); setCount('0'); setError('');
    if (!next) return;
    const ext = next.name.split('.').pop()?.toLowerCase() || '';
    if (!ALLOWED.has(ext)) { setError('Use PDF, CSV, XLSX, or an image file.'); return; }
    if (next.size > 50 * 1024 * 1024) { setError('Manifest files must be 50 MB or less.'); return; }
    try {
      setCounting(true);
      const result = await countManifestFile(next);
      if (version !== fileVersion.current) return;
      setCount(String(result.count)); setAutomatic(result.automatic);
    } catch (e) { if (version === fileVersion.current) setError(`Could not count spreadsheet rows: ${String((e as Error).message || e)}`); }
    finally { if (version === fileVersion.current) setCounting(false); }
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (submitLock.current) return;
    if (!file) { setError('Choose a file.'); return; }
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (!ALLOWED.has(ext) || file.size > 50 * 1024 * 1024) { setError('Choose an allowed file under 50 MB.'); return; }
    const itemCount = Number(count);
    if (!Number.isInteger(itemCount) || itemCount < 0) { setError('Item count must be a whole number.'); return; }
    submitLock.current = true; setBusy(true); setError(''); setNotice('');
    const id = crypto.randomUUID();
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    const path = `${storeId}/${id}/${safe}`;
    try {
      const result = await client.storage.from('floor-manifests').upload(path, file, {
        contentType: file.type || 'application/octet-stream', upsert: false,
      });
      if (result.error) throw result.error;
      const { error: rpcError } = await client.rpc('portal_create_manifest', {
        p_id: id, p_name: name.trim(), p_source: source.trim(), p_on: date,
        p_count: itemCount, p_count_source: automatic ? 'spreadsheet' : 'manual',
        p_path: path, p_content_type: file.type || 'application/octet-stream', p_size: file.size,
      });
      if (rpcError) throw rpcError;
      setName(''); setSource(''); setFile(null); setCount('0'); setAutomatic(false); if (fileInput.current) fileInput.current.value = '';
      setNotice('Manifest saved. You can tag units during receiving or in bulk below.');
      await load();
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { submitLock.current = false; setBusy(false); }
  }

  async function open(row: Manifest) {
    const { data, error: signedError } = await client.storage.from('floor-manifests')
      .createSignedUrl(row.storage_path, 60);
    if (signedError || !data?.signedUrl) { setError(signedError?.message || 'Could not open file.'); return; }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  }

  async function changeCount(row: Manifest) {
    if (submitLock.current) return;
    const entered = window.prompt('Items in this manifest', String(row.item_count));
    if (entered === null) return;
    const next = Number(entered);
    if (!Number.isInteger(next) || next < 0) { setError('Enter a whole number of items.'); return; }
    submitLock.current = true; setBusy(true); setError('');
    try {
      const { error: rpcError } = await client.rpc('portal_set_manifest_count', { p_id: row.id, p_count: next });
      if (rpcError) throw rpcError;
      await load();
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { submitLock.current = false; setBusy(false); }
  }

  async function bulkTag(event: FormEvent) {
    event.preventDefault();
    if (submitLock.current) return;
    const skus = bulkSkus;
    if (!bulkManifest || !skus.length) { setError('Choose a manifest and enter one or more SKUs.'); return; }
    if (skus.length > 1000) { setError('Tag up to 1,000 SKUs at a time.'); return; }
    submitLock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const found = new Set<string>();
      for (let offset = 0; offset < skus.length; offset += 100) {
        const { data: units, error: lookupError } = await client.from('units').select('sku').eq('store_id', storeId).in('sku', skus.slice(offset, offset + 100));
        if (lookupError) throw lookupError;
        for (const unit of units || []) found.add(unit.sku);
      }
      const missing = skus.filter(sku => !found.has(sku));
      if (missing.length) throw new Error(`No items were tagged. Unknown SKUs: ${missing.join(', ')}. Correct these and try again.`);
      const { data, error: rpcError } = await client.rpc('portal_tag_manifest', { p_id: bulkManifest, p_skus: skus });
      if (rpcError) throw rpcError;
      if (Number(data) !== skus.length) { setError(`Tagged ${data} of ${skus.length} units. Some SKUs changed while saving; review the list before retrying.`); }
      else { setNotice(`Tagged ${data} unit(s) to this manifest.`); setBulk(''); }
      await load();
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { submitLock.current = false; setBusy(false); }
  }

  return <div className="floor-tools manifests-page">
    <header><div><h1>Manifests</h1><p>Upload and manage your inventory manifests.</p></div></header>
    {error && <div className="alert" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <ToolCard><ToolHeading icon="file" title="Add manifest" description="Upload a file and add details to create a new manifest."/>
      <form className="tool-form" onSubmit={e => void upload(e)}>
        <div><label className="manifest-upload-area"><ToolIcon name="upload"/><span><strong>{file ? file.name : 'Choose a file'}</strong><small>PDF, CSV, XLSX or images · up to 50 MB</small></span><input ref={fileInput} required disabled={busy || counting} type="file" accept=".pdf,.csv,.xlsx,.png,.jpg,.jpeg,.webp,.heic,image/*" onChange={e => void chooseFile(e.target.files?.[0] || null)}/></label>{counting && <small role="status">Counting spreadsheet items…</small>}</div>
        <div className="tool-two-columns"><label>Manifest name<input required disabled={busy} value={name} placeholder="e.g. October Electronics" onChange={e => setName(e.target.value)}/></label><label>Date<input required disabled={busy} type="date" value={date} onChange={e => setDate(e.target.value)}/></label></div>
        <label>Source or vendor<input disabled={busy} value={source} placeholder="e.g. Amazon, Target, Local Vendor" onChange={e => setSource(e.target.value)}/></label>
        <label>Number of items<input disabled={busy || counting} type="number" min="0" step="1" value={count} onChange={e => { setCount(e.target.value); setAutomatic(false); }}/><small>{automatic ? 'Counted from spreadsheet. You can override it.' : 'Enter the count for PDFs and images.'}</small></label>
        <button className="tool-primary" disabled={busy || counting || !file}><ToolIcon name="upload"/>{busy ? 'Saving…' : 'Upload'}</button>
      </form>
    </ToolCard>
    <ToolCard><ToolHeading icon="file" title="Saved manifests" description="View and manage your uploaded manifests."/>
      {!loaded ? <p role="status">{error ? 'Could not load saved manifests.' : 'Loading manifests…'} {error && <button type="button" className="secondary" onClick={() => void load().catch(e => setError(String(e.message || e)))}>Retry</button>}</p> : rows.length === 0 ? <ToolEmpty icon="file" title="No manifests uploaded yet."><p>Upload a manifest above to start tracking inventory and manage your manifests here.</p></ToolEmpty>
        : <div className="manifest-list">{rows.map(row => <details className="manifest-row" key={row.id}>
          <summary><span><strong>{row.name}</strong><small>{row.manifest_on}{row.source ? ` · ${row.source}` : ''}</small></span><b>{row.item_count} items <span aria-hidden="true">›</span></b></summary>
          <div className="manifest-detail"><div className="manifest-metrics"><span>Received<b>{row.received_count}</b></span><span>Sold<b>{row.sold_count}</b></span><span>In stock<b>{row.stock_count}</b></span><span>Revenue<b>{money(row.revenue_cents)}</b></span><span>Profit<b>{money(row.profit_cents)}</b></span></div><div className="actions"><button type="button" className="secondary" onClick={() => void open(row)}>Open file</button><button type="button" className="secondary" disabled={busy} onClick={() => void changeCount(row)}>Edit item count</button></div></div>
        </details>)}</div>}
      <div className="tool-total-row"><span>Total manifested items</span><strong>{loaded ? total : '—'}</strong></div>
    </ToolCard>
    <ToolCard><ToolHeading icon="tag" title="Bulk tag inventory" description="Paste SKUs separated by commas, spaces or new lines to tag inventory to a manifest."/>
      <form onSubmit={e => void bulkTag(e)} className="manifest-bulk">
        <label>Manifest<select required disabled={busy} value={bulkManifest} onChange={e => setBulkManifest(e.target.value)}><option value="">Choose a manifest</option>{rows.map(row => <option key={row.id} value={row.id}>{row.name} · {row.manifest_on}</option>)}</select></label>
        <label>SKUs<textarea required disabled={busy} rows={4} value={bulk} onChange={e => setBulk(e.target.value)} placeholder="e.g. 10001, 10002, 10003 or one SKU per line"/></label>
        <div className="manifest-sku-count" aria-live="polite">{bulkSkus.length} unique SKUs entered</div>
        <button className="tool-primary" disabled={busy || !bulkManifest || !bulkSkus.length}><ToolIcon name="tag"/>{busy ? 'Saving…' : 'Tag inventory'}</button>
      </form>
    </ToolCard>
  </div>;
}
