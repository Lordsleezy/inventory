import { ToolCard, ToolHeading, ToolIcon, ToolEmpty } from './design/Tools';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { countManifestFile } from './manifestCount';
import { parseManifestLines } from './manifestLines';
import { backfillManifestFiles, isCsvManifestFile } from './manifestBackfill';
import { floorFunctionUrl } from './floorApi';

type Manifest = {
  line_count: number; id: string; name: string; source: string; manifest_on: string; item_count: number;
  count_source: string; storage_path: string; content_type?: string; received_count: number; sold_count: number;
  stock_count: number; revenue_cents: number; profit_cents: number;
};
type Props = { client: SupabaseClient; storeId: string; money: (cents: number) => string; layout?: 'desktop' };
function manifestDate(iso: string) {
  if (!iso) return '—';
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const ALLOWED = new Set(['pdf', 'csv', 'xlsx', 'png', 'jpg', 'jpeg', 'webp', 'heic']);

export function ManifestsPage({ client, storeId, money, layout }: Props) {
  const submitLock = useRef(false);
  const fileVersion = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [counting, setCounting] = useState(false);
  const [rows, setRows] = useState<Manifest[]>([]);
  const [allTimeReceived, setAllTimeReceived] = useState<number | null>(null);
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
  const [backfills, setBackfills] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const [manifestResult, receivedResult] = await Promise.all([
      client.rpc('portal_manifest_list'),
      client.rpc('portal_inventory_received_total'),
    ]);
    if (manifestResult.error) throw manifestResult.error;
    if (receivedResult.error) throw receivedResult.error;
    const manifests = (manifestResult.data || []) as Manifest[];
    setRows(manifests); setLoaded(true);
    setAllTimeReceived(Number(receivedResult.data || 0));
    // Backfill stored CSVs in the background; files and existing lines are never replaced.
    void backfillManifestFiles(client, manifests).then(setBackfills);
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
      if (ext === 'csv') parseManifestLines(await next.text());
      const result = await countManifestFile(next);
      if (version !== fileVersion.current) return;
      setCount(String(result.count)); setAutomatic(result.automatic);
    } catch (e) { if (version === fileVersion.current) setError(`${String((e as Error).message || e)}`); }
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
      // Validate before storing anything. CSV metadata and all lines commit together.
      const lines = ext === 'csv' ? parseManifestLines(await file.text()) : null;
      const result = await client.storage.from('floor-manifests').upload(path, file, {
        contentType: file.type || 'application/octet-stream', upsert: false,
      });
      if (result.error) throw result.error;
      const { error: rpcError } = await client.rpc(lines ? 'portal_create_manifest_with_lines' : 'portal_create_manifest', {
        p_id: id, p_name: name.trim(), p_source: source.trim(), p_on: date,
        p_count: itemCount, p_count_source: automatic ? 'spreadsheet' : 'manual',
        p_path: path, p_content_type: file.type || 'application/octet-stream', p_size: file.size,
        ...(lines ? { p_lines: lines } : {}),
      });
      if (rpcError) throw rpcError;
      if (lines?.length) {
        const { data: session } = await client.auth.getSession();
        const token = session.session?.access_token;
        if (token) {
          void fetch(floorFunctionUrl('manifest-prewarm'), {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ store_id: storeId, action: 'start', lines }),
          }).catch(() => {});
        }
      }
      setName(''); setSource(''); setFile(null); setCount('0'); setAutomatic(false); if (fileInput.current) fileInput.current.value = '';
      setNotice(lines ? `Manifest saved with ${lines.length} lines for receive retail and defect warnings.` : 'Manifest saved. Line references require a CSV upload.');
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

  if (layout === 'desktop') {
    return <ManifestsDesktop
      rows={rows} loaded={loaded} error={error} notice={notice} busy={busy} counting={counting}
      name={name} source={source} date={date} file={file} count={count} automatic={automatic}
      bulk={bulk} bulkManifest={bulkManifest} bulkSkus={bulkSkus} fileInput={fileInput}
      backfills={backfills} total={total} allTimeReceived={allTimeReceived} money={money}
      setError={setError} setName={setName} setSource={setSource} setDate={setDate} setCount={setCount} setAutomatic={setAutomatic} setBulk={setBulk} setBulkManifest={setBulkManifest}
      chooseFile={chooseFile} upload={upload} openFile={open} changeCount={changeCount} bulkTag={bulkTag} load={load}
    />;
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
          <div className="manifest-detail"><p>{backfills[row.id] || (row.line_count ? `${row.line_count} line items saved.` : isCsvManifestFile(row) ? 'Checking stored CSV for line items…' : 'Original file retained. Upload a CSV to add line references.')}</p><div className="manifest-metrics"><span>Received<b>{row.received_count}</b></span><span>Sold<b>{row.sold_count}</b></span><span>In stock<b>{row.stock_count}</b></span><span>Revenue<b>{money(row.revenue_cents)}</b></span><span>Profit<b>{money(row.profit_cents)}</b></span></div><div className="actions"><button type="button" className="secondary" onClick={() => void open(row)}>Open file</button><button type="button" className="secondary" disabled={busy} onClick={() => void changeCount(row)}>Edit item count</button></div></div>
        </details>)}</div>}
      <div className="tool-total-row"><span>Total manifested items</span><strong>{loaded ? total : '—'}</strong></div>
      <div className="tool-total-row"><span>Total inventoried (all time)</span><strong>{allTimeReceived == null ? '—' : allTimeReceived}</strong></div>
      <hr className="manifest-total-divider" />
      <div className="tool-total-row"><span>Difference</span><strong>{allTimeReceived == null ? '—' : `${total - allTimeReceived >= 0 ? '+' : '−'}${Math.abs(total - allTimeReceived)}`}</strong></div>
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

function ManifestsDesktop({
  rows, loaded, error, notice, busy, counting, name, source, date, file, count, automatic,
  bulk, bulkManifest, bulkSkus, fileInput, backfills, total, allTimeReceived, money,
  setError, setName, setSource, setDate, setCount, setAutomatic, setBulk, setBulkManifest,
  chooseFile, upload, openFile, changeCount, bulkTag, load,
}: {
  rows: Manifest[]; loaded: boolean; error: string; notice: string; busy: boolean; counting: boolean;
  name: string; source: string; date: string; file: File | null; count: string; automatic: boolean;
  bulk: string; bulkManifest: string; bulkSkus: string[]; fileInput: RefObject<HTMLInputElement | null>;
  backfills: Record<string, string>; total: number; allTimeReceived: number | null; money: (cents: number) => string;
  setError: (v: string) => void; setName: (v: string) => void; setSource: (v: string) => void; setDate: (v: string) => void;
  setCount: (v: string) => void; setAutomatic: (v: boolean) => void; setBulk: (v: string) => void; setBulkManifest: (v: string) => void;
  chooseFile: (next: File | null) => Promise<void>;
  upload: (event: FormEvent) => Promise<void>;
  openFile: (row: Manifest) => Promise<void>;
  changeCount: (row: Manifest) => Promise<void>;
  bulkTag: (event: FormEvent) => Promise<void>;
  load: () => Promise<void>;
}) {
  const [panel, setPanel] = useState<null | 'forms' | 'detail'>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = rows.find((row) => row.id === detailId) || null;
  const accept = '.pdf,.csv,.xlsx,.png,.jpg,.jpeg,.webp,.heic,image/*';

  function takeFile(next: File | null) {
    void chooseFile(next);
    if (next) setPanel('forms');
  }

  return (
    <div className="manifests-desk">
      <header className="manifests-desk-head">
        <div>
          <h1>Manifests</h1>
          <p>Pallet and load paperwork.</p>
        </div>
        <div className="actions">
          <button type="button" onClick={() => setPanel('forms')}>Bulk tag inventory</button>
          <button type="button" className="primary" onClick={() => setPanel('forms')}>Add manifest</button>
        </div>
      </header>
      {error && <div className="alert" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      <label
        className="manifests-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); takeFile(e.dataTransfer.files?.[0] || null); }}
      >
        <input className="sr" disabled={busy || counting} type="file" accept={accept} onChange={(e) => takeFile(e.target.files?.[0] || null)} />
        Drop a manifest file here, or <span>choose a file</span> · PDF, CSV, XLSX or images, up to 50 MB
      </label>
      {!loaded ? <p role="status">{error ? 'Could not load saved manifests.' : 'Loading manifests…'} {error && <button type="button" onClick={() => void load().catch((e) => setError(String(e.message || e)))}>Retry</button>}</p>
        : rows.length === 0 ? <p className="hint">No manifests yet. Drop a file above or use Add manifest.</p>
        : (
          <table className="desk-table manifests-table">
            <thead>
              <tr><th>Manifest</th><th>Date</th><th>Source</th><th className="num">Items</th><th><span className="sr">Actions</span></th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td><strong>{row.name}</strong></td>
                  <td>{manifestDate(row.manifest_on)}</td>
                  <td>{row.source || '—'}</td>
                  <td className="num">{row.item_count.toLocaleString('en-US')}</td>
                  <td className="manifests-actions">
                    <button type="button" onClick={() => { setDetailId(row.id); setPanel('detail'); }}>Open</button>
                    <button type="button" onClick={() => void openFile(row)}>Open file</button>
                    <button type="button" disabled={busy} onClick={() => void changeCount(row)}>Edit count</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {loaded && <p className="hint">Total manifested {total.toLocaleString('en-US')} · Inventoried all time {allTimeReceived == null ? '—' : allTimeReceived.toLocaleString('en-US')}</p>}
      {panel && (
        <>
          <button type="button" className="desk-drawer-scrim" aria-label="Close panel" onClick={() => setPanel(null)} />
          <aside className="desk-drawer manifests-drawer" role="dialog" aria-label={panel === 'detail' ? 'Manifest' : 'Add manifest'}>
            <div className="manifests-drawer-head">
              <h2>{panel === 'detail' ? (detail?.name || 'Manifest') : 'Add manifest'}</h2>
              <button type="button" onClick={() => setPanel(null)}>Close</button>
            </div>
            {panel === 'detail' && detail && (
              <div className="manifests-detail">
                <div className="desk-headline">
                  <div><span>Expected</span><strong>{detail.item_count.toLocaleString('en-US')}</strong></div>
                  <div><span>Received</span><strong>{detail.received_count.toLocaleString('en-US')}</strong></div>
                  <div><span>Difference</span><strong>{`${detail.item_count - detail.received_count >= 0 ? '+' : '−'}${Math.abs(detail.item_count - detail.received_count).toLocaleString('en-US')}`}</strong></div>
                </div>
                <p>{backfills[detail.id] || (detail.line_count ? `${detail.line_count} line items saved.` : isCsvManifestFile(detail) ? 'Checking stored CSV for line items…' : 'Original file retained. Upload a CSV to add line references.')}</p>
                <ul className="manifests-metrics">
                  <li><span>Sold</span><b>{detail.sold_count}</b></li>
                  <li><span>In stock</span><b>{detail.stock_count}</b></li>
                  <li><span>Revenue</span><b>{money(detail.revenue_cents)}</b></li>
                  <li><span>Profit</span><b>{money(detail.profit_cents)}</b></li>
                </ul>
                <div className="actions">
                  <button type="button" onClick={() => void openFile(detail)}>Open file</button>
                  <button type="button" disabled={busy} onClick={() => void changeCount(detail)}>Edit count</button>
                </div>
              </div>
            )}
            {panel === 'forms' && (
              <>
                <form className="manifests-form" onSubmit={(e) => void upload(e)}>
                  <label className="manifests-drop slim">
                    <input ref={fileInput} className="sr" disabled={busy || counting} type="file" accept={accept} onChange={(e) => void chooseFile(e.target.files?.[0] || null)} />
                    {file ? file.name : 'Choose a file · PDF, CSV, XLSX, images'}
                  </label>
                  {counting && <small role="status">Counting spreadsheet items…</small>}
                  <label>Manifest name<input required disabled={busy} value={name} placeholder="e.g. October Electronics" onChange={(e) => setName(e.target.value)} /></label>
                  <div className="manifests-form-row">
                    <label>Date<input required disabled={busy} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
                    <label>Source<input disabled={busy} value={source} placeholder="Costco, Target" onChange={(e) => setSource(e.target.value)} /></label>
                  </div>
                  <label>Item count · PDFs and images only<input disabled={busy || counting} type="number" min="0" step="1" value={count} onChange={(e) => { setCount(e.target.value); setAutomatic(false); }} /></label>
                  <small>{automatic ? 'Counted from the spreadsheet. You can override it.' : 'Enter the count for PDFs and images.'}</small>
                  <button type="submit" className="primary" disabled={busy || counting || !file}>{busy ? 'Saving…' : 'Upload'}</button>
                </form>
                <form className="manifests-form" onSubmit={(e) => void bulkTag(e)}>
                  <h2>Bulk tag inventory</h2>
                  <label>Manifest
                    <select required disabled={busy} value={bulkManifest} onChange={(e) => setBulkManifest(e.target.value)}>
                      <option value="">Choose a manifest</option>
                      {rows.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                    </select>
                  </label>
                  <label>SKUs · commas, spaces or one per line
                    <textarea required disabled={busy} rows={4} value={bulk} placeholder="10001, 10002, 10003" onChange={(e) => setBulk(e.target.value)} />
                  </label>
                  <div className="manifests-form-foot">
                    <button type="submit" className="primary" disabled={busy || !bulkManifest || !bulkSkus.length}>{busy ? 'Saving…' : 'Tag inventory'}</button>
                    <span>{bulkSkus.length} unique SKUs</span>
                  </div>
                </form>
              </>
            )}
          </aside>
        </>
      )}
    </div>
  );
}
