import { useCallback, useEffect, useMemo, useState } from 'react';
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
  const total = useMemo(() => rows.reduce((n, row) => n + row.item_count, 0), [rows]);

  async function chooseFile(next: File | null) {
    setFile(next); setName((old) => old || next?.name.replace(/\.[^.]+$/, '') || '');
    setAutomatic(false); setCount('0'); setError('');
    if (!next) return;
    const ext = next.name.split('.').pop()?.toLowerCase() || '';
    if (!ALLOWED.has(ext)) { setError('Use PDF, CSV, XLSX, or an image file.'); return; }
    if (next.size > 50 * 1024 * 1024) { setError('Manifest files must be 50 MB or less.'); return; }
    try {
      const result = await countManifestFile(next);
      setCount(String(result.count)); setAutomatic(result.automatic);
    } catch (e) { setError(`Could not count spreadsheet rows: ${String((e as Error).message || e)}`); }
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) { setError('Choose a file.'); return; }
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (!ALLOWED.has(ext) || file.size > 50 * 1024 * 1024) { setError('Choose an allowed file under 50 MB.'); return; }
    const itemCount = Number(count);
    if (!Number.isInteger(itemCount) || itemCount < 0) { setError('Item count must be a whole number.'); return; }
    setBusy(true); setError(''); setNotice('');
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
      setName(''); setSource(''); setFile(null); setCount('0'); setAutomatic(false);
      setNotice('Manifest saved. You can tag units during receiving or in bulk below.');
      await load();
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); }
  }

  async function open(row: Manifest) {
    const { data, error: signedError } = await client.storage.from('floor-manifests')
      .createSignedUrl(row.storage_path, 60);
    if (signedError || !data?.signedUrl) { setError(signedError?.message || 'Could not open file.'); return; }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  }

  async function changeCount(row: Manifest) {
    const entered = window.prompt('Items in this manifest', String(row.item_count));
    if (entered === null) return;
    const next = Number(entered);
    if (!Number.isInteger(next) || next < 0) { setError('Enter a whole number of items.'); return; }
    setBusy(true); setError('');
    try {
      const { error: rpcError } = await client.rpc('portal_set_manifest_count', { p_id: row.id, p_count: next });
      if (rpcError) throw rpcError;
      await load();
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); }
  }

  async function bulkTag(event: FormEvent) {
    event.preventDefault();
    const skus = [...new Set(bulk.split(/[\s,;]+/).map((sku) => sku.trim()).filter(Boolean))];
    if (!bulkManifest || !skus.length) { setError('Choose a manifest and enter one or more SKUs.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const { data, error: rpcError } = await client.rpc('portal_tag_manifest', { p_id: bulkManifest, p_skus: skus });
      if (rpcError) throw rpcError;
      setNotice(`Tagged ${data} unit(s) to this manifest.`); setBulk(''); await load();
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); }
  }

  return <div className="manifests-page">
    <header><div><div className="eyebrow">LOADS</div><h1>Manifests</h1><p>Keep original files and track the inventory and profit from each load.</p></div></header>
    {error && <div className="alert" role="alert">{error}<button type="button" onClick={() => setError('')}>×</button></div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel"><h2>Add manifest</h2><form className="manifest-form" onSubmit={(e) => void upload(e)}>
      <label>File<input required type="file" accept=".pdf,.csv,.xlsx,image/*" onChange={(e) => void chooseFile(e.target.files?.[0] || null)} /></label>
      <label>Name<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>Date<input required type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <label>Source or vendor<input value={source} onChange={(e) => setSource(e.target.value)} /></label>
      <label>Items<input type="number" min="0" step="1" value={count} onChange={(e) => { setCount(e.target.value); setAutomatic(false); }} />
        <small>{automatic ? 'Counted from spreadsheet. You can override it.' : 'Enter the count for PDFs and images.'}</small></label>
      <div className="actions"><button disabled={busy || !file}>Upload manifest</button></div>
    </form></section>
    <section className="panel"><h2>Saved manifests</h2>
      {!loaded ? <p>Loading…</p> : rows.length === 0 ? <p className="empty">No manifests uploaded yet.</p>
        : <div className="manifest-list">{rows.map((row) => <details className="manifest-row" key={row.id}>
          <summary><span><strong>{row.name}</strong><small>{row.manifest_on}{row.source ? ` · ${row.source}` : ''}</small></span>
            <b>{row.item_count} items</b></summary>
          <div className="manifest-detail"><div className="manifest-metrics">
            <span>Received <b>{row.received_count}</b></span><span>Sold <b>{row.sold_count}</b></span>
            <span>In stock <b>{row.stock_count}</b></span><span>Revenue <b>{money(row.revenue_cents)}</b></span>
            <span>Profit <b>{money(row.profit_cents)}</b></span>
          </div><div className="actions">
            <button type="button" className="secondary" onClick={() => void open(row)}>Open file</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => void changeCount(row)}>Edit item count</button>
          </div></div>
        </details>)}</div>}
      <div className="net"><span>Total manifested items</span><strong>{total}</strong></div>
    </section>
    <section className="panel"><h2>Bulk tag inventory</h2><p className="hint">Paste SKUs separated by commas, spaces, or new lines.</p>
      <form onSubmit={(e) => void bulkTag(e)} className="manifest-bulk">
        <select required value={bulkManifest} onChange={(e) => setBulkManifest(e.target.value)}>
          <option value="">Choose manifest</option>{rows.map((row) => <option key={row.id} value={row.id}>{row.name} · {row.manifest_on}</option>)}
        </select>
        <textarea required rows={3} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder="SKU 10001, 10002, 10003" />
        <button disabled={busy}>Tag units</button>
      </form>
    </section>
  </div>;
}
