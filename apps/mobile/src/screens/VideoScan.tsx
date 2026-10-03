import { useEffect, useRef, useState } from 'react';
import { floorCloud } from '@floor/cloud';
import { parseMoneyToCents } from '@floor/store';
import { authHeader, functionsUrl } from '../functions';
import { startVideoScan, type RecordedScan } from '../video-scan-capture';

type Draft = Record<string, unknown> & {
  title?: string; brand?: string; model?: string; category?: string; condition?: string;
  condition_notes?: string; description?: string; ebay_title?: string; ebay_category?: string;
  ebay_item_specifics?: Record<string, string>; retail_prices?: { store: string; price_cents: number; url: string }[];
  msrp_cents?: number; uncertain_fields?: string[]; options?: { label: string; brand: string; model: string; color: string }[];
};
type Job = { id: string; status: string; result: Draft | null; error: string | null; sku: string | null; created_at: string };

const moneyPattern = /^\d*(?:\.\d{0,2})?$/;
function dollars(cents: number) { return `$${(cents / 100).toFixed(2)}`; }
async function post(path: string, id: string) {
  const response = await fetch(functionsUrl(path), { method: 'POST', headers: {
    ...await authHeader(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Scan request failed (${response.status})`);
  return body;
}

export function VideoScan({ manager }: { manager: boolean }) {
  const preview = useRef<HTMLVideoElement>(null);
  const recording = useRef<{ stop: () => void; abort: () => void } | null>(null);
  const [started, setStarted] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [savedSku, setSavedSku] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [retailEdits, setRetailEdits] = useState<Record<string, string>>({});
  const [specificsEdits, setSpecificsEdits] = useState<Record<string, string>>({});
  const [costEdits, setCostEdits] = useState<Record<string, string>>({});
  const [floorEdits, setFloorEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const { data, error: queryError } = await floorCloud().from('video_scan_jobs')
        .select('id,status,result,error,sku,created_at').order('created_at', { ascending: false }).limit(20);
      if (active && !queryError) setJobs((data || []) as Job[]);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3500);
    return () => { active = false; window.clearInterval(timer); recording.current?.abort(); };
  }, []);

  async function uploaded(scan: RecordedScan) {
    setBusy(true); setError('');
    try {
      if (scan.seconds < 10 || scan.video.size < 100_000) throw new Error('Record at least 10 seconds with a clear walk-around.');
      if (scan.video.size > 15 * 1024 * 1024) throw new Error('Video is over 15 MB. Please scan again.');
      const { data: storeId, error: storeError } = await floorCloud().rpc('current_store_id');
      if (storeError || !storeId) throw storeError || new Error('No store linked to this login');
      const { data: auth } = await floorCloud().auth.getUser();
      const userId = auth.user?.id;
      if (!userId) throw new Error('Sign in to scan');
      const id = crypto.randomUUID();
      const prefix = `${storeId}/${userId}/${id}`;
      const extension = scan.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
      const videoPath = `${prefix}/video.${extension}`;
      const stillPaths = scan.stills.map((_, index) => `${prefix}/still-${index}.jpg`);
      const bucket = floorCloud().storage.from('video-scan-staging');
      const uploadedPaths: string[] = [];
      try {
        for (const [path, blob] of [[videoPath, scan.video] as const, ...scan.stills.map((blob, index) => [stillPaths[index], blob] as const)]) {
          const up = await bucket.upload(path, blob, { contentType: path.endsWith('.jpg') ? 'image/jpeg' : scan.mimeType });
          if (up.error) throw up.error;
          uploadedPaths.push(path);
        }
        const created = await floorCloud().rpc('video_scan_create', { p_id: id, p_video_path: videoPath, p_still_paths: stillPaths });
        if (created.error) throw created.error;
        await post('video-scan-start', id);
      } catch (uploadError) {
        await bucket.remove(uploadedPaths);
        throw uploadError;
      }
      setJobs(previous => [{ id, status: 'processing', result: null, error: null, sku: null, created_at: new Date().toISOString() }, ...previous]);
      setSuccess('Scan uploaded. You can start another while it processes.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function start() {
    setError(''); setSuccess(''); setSavedSku('');
    try {
      const budget = await floorCloud().rpc('video_scan_budget');
      if (budget.error) throw budget.error;
      const limit = budget.data as { spent_usd: number; reserved_usd: number; monthly_cap_usd: number };
      if (Number(limit.spent_usd) + Number(limit.reserved_usd) + 1 > Number(limit.monthly_cap_usd))
        throw new Error('The monthly AI scan cap is reached. An admin can raise it in Inventory → Receive; manual Receive still works.');
      if (!preview.current) return;
      recording.current = await startVideoScan(preview.current, scan => { recording.current = null; setStarted(0); void uploaded(scan); },
        cause => { setError(cause.message); recording.current = null; setStarted(0); });
      setStarted(Date.now());
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function draftFor(job: Job): Draft { return drafts[job.id] || job.result || {}; }
  function edit(job: Job, key: string, value: unknown) {
    setDrafts(previous => ({ ...previous, [job.id]: { ...draftFor(job), [key]: value } }));
  }

  async function save(job: Job) {
    const price = parseMoneyToCents(prices[job.id] || '');
    if (price === undefined || price === null || price <= 0) { setError('Enter your selling price before saving.'); return; }
    const retail = retailEdits[job.id] === undefined ? draftFor(job).msrp_cents : parseMoneyToCents(retailEdits[job.id]);
    if (retail === undefined) { setError('Check the retail price.'); return; }
    const cost = manager ? parseMoneyToCents(costEdits[job.id] || '') : null;
    const floor = manager ? parseMoneyToCents(floorEdits[job.id] || '') : null;
    if (cost === undefined || floor === undefined) { setError('Check the cost or floor amount.'); return; }
    let specifics = draftFor(job).ebay_item_specifics || {};
    try {
      if (specificsEdits[job.id] !== undefined) specifics = JSON.parse(specificsEdits[job.id]);
      if (!specifics || Array.isArray(specifics) || typeof specifics !== 'object') throw new Error();
    } catch { setError('eBay item specifics must be a JSON object.'); return; }
    setSaving(job.id); setError('');
    try {
      const { data, error: saveError } = await floorCloud().rpc('video_scan_receive', {
        p_id: job.id, p_draft: { ...draftFor(job), msrp_cents: retail,
          acquisition_cost_cents: cost, floor_cents: floor, ebay_item_specifics: specifics }, p_ask_cents: price });
      if (saveError) throw saveError;
      const sku = (data as { sku: string }).sku;
      setSavedSku(sku);
      try { await post('video-scan-photos', job.id); }
      catch (photoError) { setError(`SKU ${sku} saved. Stills need retry: ${photoError instanceof Error ? photoError.message : photoError}`); }
      setSuccess('Write this number on the unit. Ready for your next scan.');
      setJobs(previous => previous.map(row => row.id === job.id ? { ...row, status: 'saved', sku } : row));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(null); }
  }

  return <section className="card p-4 my-4">
    <h2 className="text-title">AI video scan</h2>
    <p className="text-quiet text-floor-mute">Film the front, sides, labels and box for 10–20 seconds. Speak any defects. Review every suggestion before saving.</p>
    <video ref={preview} className="w-full rounded-lg mt-3" autoPlay muted playsInline style={{ display: started ? 'block' : 'none' }} />
    <div className="flex gap-2 mt-3">
      {!started ? <button type="button" className="btn-accent" disabled={busy} onClick={() => void start()}>{busy ? 'Uploading…' : 'Scan'}</button>
        : <button type="button" className="btn-accent" onClick={() => recording.current?.stop()}>Finish scan</button>}
    </div>
    {started > 0 && <p className="text-quiet">Recording; stops automatically at 20 seconds.</p>}
    {success && <div role="status" className="mt-3"><p>{success}</p>{savedSku && <strong className="text-title font-mono">SKU {savedSku}</strong>}</div>}
    {error && <p role="alert" className="text-floor-danger">{error}</p>}
    {jobs.filter(job => job.status !== 'saved').map(job => {
      const draft = draftFor(job);
      return <details key={job.id} className="mt-4 border-t pt-3" open={job.status === 'ready'}>
        <summary>{new Date(job.created_at).toLocaleString()} · {job.status === 'processing' || job.status === 'queued' ? 'Analyzing video…' : job.status === 'failed' ? 'Scan failed' : draft.title || 'Ready to review'}</summary>
        {job.status === 'failed' && <p>{job.error || 'AI failed. Use the manual Receive form below.'}</p>}
        {job.status === 'ready' && <div className="grid gap-2 mt-3">
          {draft.uncertain_fields?.length ? <p className="text-floor-danger">Check: {draft.uncertain_fields.join(', ')}</p> : null}
          {draft.options?.length ? <label>Possible matches<select className="field" onChange={e => {
            const option = draft.options?.[Number(e.target.value)];
            if (option) setDrafts(previous => ({ ...previous, [job.id]: { ...draft, brand: option.brand, model: option.model, color: option.color } }));
          }}><option value="">Choose if needed</option>{draft.options.map((option, index) => <option key={index} value={index}>{option.label}</option>)}</select></label> : null}
          {(['title','brand','model','category','condition','test_status','location','condition_notes','description','ebay_title','ebay_category','upc','mfr_serial','lot'] as const).map(key =>
            <label key={key}>{key.replace(/_/g, ' ')}{key === 'description' || key === 'condition_notes'
              ? <textarea className="field" value={String(draft[key] || '')} onChange={e => edit(job,key,e.target.value)} />
              : <input className="field" value={String(draft[key] || '')} maxLength={key === 'ebay_title' ? 80 : undefined} onChange={e => edit(job,key,e.target.value)} />}</label>)}
          <label>eBay item specifics (JSON)<textarea className="field" value={specificsEdits[job.id] ?? JSON.stringify(draft.ebay_item_specifics || {}, null, 2)}
            onChange={e => setSpecificsEdits(previous => ({ ...previous, [job.id]: e.target.value }))} /></label>
          <div><strong>Highest exact retail price: {draft.msrp_cents ? dollars(Number(draft.msrp_cents)) : 'No verified price'}</strong>
            {draft.retail_prices?.map((price, index) => <p key={index}><a href={price.url} target="_blank" rel="noreferrer">{price.store}: {dollars(price.price_cents)}</a></p>)}</div>
          <label>MSRP / retail price (editable)<input className="field" inputMode="decimal" value={retailEdits[job.id] ?? (draft.msrp_cents ? (Number(draft.msrp_cents) / 100).toFixed(2) : '')}
            onChange={e => { if (moneyPattern.test(e.target.value)) setRetailEdits(previous => ({ ...previous, [job.id]: e.target.value })); }} /></label>
          {manager && <><label>Item cost<input className="field" inputMode="decimal" value={costEdits[job.id] || ''}
            onChange={e => { if (moneyPattern.test(e.target.value)) setCostEdits(previous => ({ ...previous, [job.id]: e.target.value })); }} /></label>
            <label>Floor price<input className="field" inputMode="decimal" value={floorEdits[job.id] || ''}
              onChange={e => { if (moneyPattern.test(e.target.value)) setFloorEdits(previous => ({ ...previous, [job.id]: e.target.value })); }} /></label></>}
          <label>What do you want to price it at? <input className="field" inputMode="decimal" placeholder="Required; enter your price"
            value={prices[job.id] || ''} onChange={e => { if (moneyPattern.test(e.target.value)) setPrices(previous => ({ ...previous, [job.id]: e.target.value })); }} /></label>
          <button type="button" className="btn-accent" disabled={saving === job.id} onClick={() => void save(job)}>{saving === job.id ? 'Saving…' : 'Save and scan next'}</button>
        </div>}
      </details>;
    })}
  </section>;
}
