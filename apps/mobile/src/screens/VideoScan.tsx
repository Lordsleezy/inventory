import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { floorCloud } from '@floor/cloud';
import { parseMoneyToCents } from '@floor/store';
import { functionsUrl } from '../functions';
import { prewarmVideoScan, releaseWarmVideoScan, startVideoScan } from '../video-scan-capture';

type Price = { store: string; price_cents: number; url: string; pack_size?: number; approximate?: boolean; product_name?: string };
type Identity = { title?: string; brand?: string; model?: string; color?: string; identified_at?: string; retail_started_at?: string; retail_at?: string;
  options?: { label: string; title: string; brand: string; model: string; color: string; thumbnail_data_url?: string }[];
  retail_prices?: Price[]; msrp_cents?: number; retail_ready?: boolean };
type Job = { id: string; status: string; result: Identity | null; error: string | null; sku: string | null; created_at: string; updated_at: string };
const moneyPattern = /^\d*(?:\.\d{0,2})?$/;
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const distinctOptions = (result: Identity) => [...new Map((result.options || []).map((option, index) => [
  [option.brand, option.model, option.color, option.title].join('|').toLowerCase(), { ...option, index }])).values()];

async function scanSession(verify = false) {
  const sb = floorCloud();
  const { data, error } = await sb.auth.getSession();
  if (error || !data.session) {
    await sb.auth.signOut({ scope: 'local' }).catch(() => undefined);
    throw new Error('Sign in again to continue your pending scans.');
  }
  if (verify) {
    const checked = await sb.auth.getUser();
    if (checked.error || !checked.data.user) {
      const refreshed = await sb.auth.refreshSession();
      if (refreshed.error || !refreshed.data.session) {
        await sb.auth.signOut({ scope: 'local' }).catch(() => undefined);
        throw new Error('Your Floor session expired. Sign in again; your pending scans are saved.');
      }
      return refreshed.data.session;
    }
  }
  return data.session;
}

async function post(path: string, id: string, extra: Record<string, unknown> = {}) {
  const sb = floorCloud();
  const session = await scanSession();
  const send = async (token: string) => {
    const response = await fetch(functionsUrl(path), { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...extra }) });
    return { response, body: await response.json().catch(() => ({})) };
  };
  let result = await send(session.access_token);
  if (result.response.status === 401 || result.body.error === 'Sign in required') {
    // A cached JWT can outlive a server session (for example after a sign-out
    // on another device). Refresh once, then show Login instead of stranding a job.
    const refreshed = await sb.auth.refreshSession();
    if (refreshed.data.session?.access_token) result = await send(refreshed.data.session.access_token);
    if (!refreshed.data.session || result.response.status === 401 || result.body.error === 'Sign in required') {
      await sb.auth.signOut({ scope: 'local' }).catch(() => undefined);
      throw new Error('Your Floor session expired. Sign in again; your pending scans are saved.');
    }
  }
  if (!result.response.ok) throw new Error(result.body.error || `Scan request failed (${result.response.status})`);
  return result.body;
}

type Account = { prefix: string; stillPaths: string[]; userId: string; storeId: string };
const pendingStatuses = ['queued', 'processing', 'ready', 'failed'];
const timedOut = (job: Job, at: number) =>
  (job.status === 'queued' && at - Date.parse(job.created_at) > 20_000) ||
  (job.status === 'processing' && at - Date.parse(job.updated_at || job.created_at) > 150_000);

export function VideoScan() {
  const navigate = useNavigate();
  const preview = useRef<HTMLVideoElement>(null);
  const recording = useRef<{ stop: () => void; abort: () => void } | null>(null);
  const uploads = useRef<Record<string, Promise<void> | undefined>>({});
  const early = useRef<Record<string, Promise<void> | undefined>>({});
  const stopTimes = useRef<Record<string, number>>({});
  const announced = useRef<Record<string, boolean>>({});
  const priceAnnounced = useRef<Record<string, boolean>>({});
  const [started, setStarted] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedSku, setSavedSku] = useState('');
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [choosing, setChoosing] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [ownThumb, setOwnThumb] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const { data } = await floorCloud().from('video_scan_jobs')
        .select('id,status,result,error,sku,created_at,updated_at').in('status', pendingStatuses)
        .order('created_at', { ascending: false }).limit(30);
      if (active && data) setJobs(data as Job[]);
    };
    void refresh();
    // Warm camera + RPCs while the clerk is still reading Receive.
    prewarmVideoScan();
    void floorCloud().rpc('video_scan_budget');
    void floorCloud().rpc('current_store_id');
    return () => { active = false; recording.current?.abort(); releaseWarmVideoScan(); };
  }, []);

  const pendingWork = jobs.some(job => !timedOut(job, now) && (job.status === 'processing' || job.status === 'queued'
    || (job.status === 'ready' && !job.result?.retail_ready)));
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now());
      void floorCloud().from('video_scan_jobs')
        .select('id,status,result,error,sku,created_at,updated_at').in('status', pendingStatuses)
        .order('created_at', { ascending: false }).limit(30)
        .then(({ data }) => { if (data) setJobs(previous => (data as Job[]).map(row =>
          row.status === 'queued' && previous.some(old => old.id === row.id && old.status === 'failed')
            ? { ...row, status: 'failed' } : row)); });
    }, pendingWork ? 650 : 2500);
    return () => window.clearInterval(timer);
  }, [pendingWork]);

  async function start() {
    const openStarted = performance.now();
    setError(''); setSavedSku(''); setBusy(true);
    if (!preview.current) { setBusy(false); return; }
    const id = crypto.randomUUID();
    setActiveId(id);
    // Show the preview immediately; do not wait on budget/store before the camera.
    setStarted(true);
    let prefix = '';
    let stillPaths: string[] = [];
    const extension = MediaRecorder.isTypeSupported('video/mp4') ? 'mp4' : 'webm';
    const bucket = floorCloud().storage.from('video-scan-staging');
    let earlyStills: Blob[] = [];
    const account = (async (): Promise<Account> => {
      const [budget, store, session] = await Promise.all([
        floorCloud().rpc('video_scan_budget'),
        floorCloud().rpc('current_store_id'),
        scanSession(true),
      ]);
      if (budget.error) throw budget.error;
      const limit = budget.data as { spent_usd: number; reserved_usd: number; monthly_cap_usd: number };
      if (Number(limit.spent_usd) + Number(limit.reserved_usd) + 1 > Number(limit.monthly_cap_usd))
        throw new Error('Monthly AI scan cap reached. Use manual Receive or ask an admin to raise it.');
      if (store.error || !store.data) throw store.error || new Error('Store login required');
      const userId = session.user.id;
      prefix = `${store.data}/${userId}/${id}`;
      stillPaths = Array.from({ length: 4 }, (_, index) => `${prefix}/still-${index}.jpg`);
      return { prefix, stillPaths, userId, storeId: String(store.data) };
    })();
    const beginIdentify = (stills: Blob[]) => {
      if (early.current[id]) return;
      earlyStills = stills;
      if (stills[0]) setOwnThumb(URL.createObjectURL(stills[0]));
      early.current[id] = (async () => {
        const ready = await account;
        // Only register paths we actually upload now. Listing missing still-1/2/3 made
        // the background worker fail while the job stayed stuck on "Identifying…".
        const uploadedPaths = ready.stillPaths.slice(0, stills.length);
        const sent = await Promise.all(stills.map((blob, index) =>
          bucket.upload(uploadedPaths[index], blob, { contentType: 'image/jpeg' })));
        for (const item of sent) if (item.error) throw item.error;
        const created = await floorCloud().rpc('video_scan_create', {
          p_id: id, p_video_path: `${ready.prefix}/video.${extension}`, p_still_paths: uploadedPaths });
        if (created.error) throw created.error;
        setJobs(previous => [{ id, status: 'queued', result: null, error: null, sku: null,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, ...previous]);
        await post('video-scan-start', id);
      })();
      early.current[id]?.catch((cause: unknown) => {
        setJobs(previous => previous.map(job => job.id === id ? { ...job, status: 'failed' } : job));
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    };
    try {
      // Camera opens while budget/store finish in the background.
      const camera = startVideoScan(preview.current, scan => {
        recording.current = null; setStarted(false); stopTimes.current[id] = performance.now();
        uploads.current[id] = (async () => {
          await account;
          if (scan.video.size < 4_096) throw new Error('The camera did not save the video. Please rescan.');
          if (scan.video.size > 15 * 1024 * 1024) throw new Error('Video is over 15 MB.');
          if (!early.current[id]) beginIdentify(scan.stills.slice(0, 2));
          // The full video is only needed after Save. Identification is already running from stills.
          const video = bucket.upload(`${prefix}/video.${extension}`, scan.video, { contentType: scan.mimeType });
          await early.current[id];
          const rest = await Promise.all(scan.stills.map((blob, index) =>
            blob === earlyStills[index] ? Promise.resolve({ error: null }) :
              bucket.upload(stillPaths[index], blob, { contentType: 'image/jpeg', upsert: index < earlyStills.length })));
          for (const item of rest) if (item.error) throw item.error;
          const uploaded = await video;
          if (uploaded.error) throw uploaded.error;
        })();
        uploads.current[id].catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
      }, cause => {
        setError(cause.message); recording.current = null; setStarted(false); setActiveId(null);
        void (async () => {
          await early.current[id]?.catch(() => undefined);
          await account.catch(() => undefined);
          if (prefix) await post('video-scan-discard', id).catch(() => undefined);
          if (stillPaths.length) await bucket.remove([...stillPaths, `${prefix}/video.${extension}`]);
        })();
      }, beginIdentify);
      recording.current = await camera;
      console.info('Floor scan camera-open ms', Math.round(performance.now() - openStarted));
      // Preview is live — unlock the button; account checks continue in the background.
      setBusy(false);
      try { await account; }
      catch (cause) {
        recording.current?.abort();
        recording.current = null;
        setStarted(false);
        setActiveId(null);
        throw cause;
      }
    } catch (cause) { setActiveId(null); setStarted(false); setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  }

  async function save(job: Job, editAfter = false) {
    const price = parseMoneyToCents(prices[job.id] || '');
    if (price === undefined || price === null || price <= 0) { setError('Enter your selling price.'); return; }
    const cost = parseMoneyToCents(costs[job.id] || '');
    if (cost === undefined) { setError('Check the cost amount.'); return; }
    const result = job.result || {};
    if (choosing === job.id || (distinctOptions(result).length >= 2 && choices[job.id] === undefined)) {
      setError('Pick the matching product first.'); return;
    }
    const chosen = result.options?.[choices[job.id]];
    setSaving(job.id); setError('');
    try {
      // SKU mint only needs the job + identity. Do not wait on the full video upload.
      if (early.current[job.id]) await early.current[job.id];
      const draft = { ...result, ...(chosen || {}) };
      const { data, error: saveError } = await floorCloud().rpc('video_scan_receive', {
        p_id: job.id, p_draft: draft, p_ask_cents: price });
      if (saveError) throw saveError;
      const sku = (data as { sku: string }).sku;
      setSavedSku(sku);
      // Acquisition cost is optional; a unit without one still saves and sells (it shows as missing cost in Admin).
      if (cost !== null) void Promise.resolve(floorCloud().rpc('set_unit_cost_if_missing', { p_sku: sku, p_cost_cents: cost }))
        .then(({ error: costError }) => { if (costError) setError(`SKU ${sku} saved; add its cost later: ${costError.message}`); });
      setActiveId(null);
      setJobs(previous => previous.map(row => row.id === job.id ? { ...row, status: 'saved', sku } : row));
      setPrices(previous => { const next = { ...previous }; delete next[job.id]; return next; });
      setCosts(previous => { const next = { ...previous }; delete next[job.id]; return next; });
      // Photos/enrich wait on remaining uploads in the background; clerk can scan again now.
      void (async () => {
        try { await uploads.current[job.id]; } catch { /* photo/enrich retries below surface errors */ }
        try { await post('video-scan-photos', job.id); }
        catch (cause) { setError(`SKU ${sku} saved; photos need retry: ${(cause as Error).message}`); }
        try { await post('video-scan-enrich-start', job.id); }
        catch (cause) { setError(`SKU ${sku} saved; details need retry: ${(cause as Error).message}`); }
      })();
      window.setTimeout(() => setSavedSku(current => current === sku ? '' : current), 12000);
      if (editAfter) navigate(`/inventory/${sku}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(null); }
  }

  async function discard(job: Job) {
    if (confirmDiscardId !== job.id) { setConfirmDiscardId(job.id); return; }
    setConfirmDiscardId(null);
    setError('');
    try {
      await post('video-scan-discard', job.id);
      setJobs(previous => previous.filter(row => row.id !== job.id));
      if (activeId === job.id) setActiveId(null);
      // A video upload already in flight can finish after the first cleanup.
      // Repeat the idempotent cleanup then without blocking the Discard button.
      if (uploads.current[job.id]) {
        const cleanAgain = () => post('video-scan-discard', job.id).catch(() => undefined);
        void uploads.current[job.id]?.then(cleanAgain, cleanAgain);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function retry(job: Job) {
    setError(''); setActiveId(job.id);
    setJobs(previous => previous.map(row => row.id === job.id ? { ...row, status: 'processing', error: null } : row));
    try {
      await post('video-scan-start', job.id);
      setJobs(previous => previous.map(row => row.id === job.id ? { ...row, status: 'processing', updated_at: new Date().toISOString() } : row));
    }
    catch (cause) {
      setJobs(previous => previous.map(row => row.id === job.id ? { ...row, status: 'failed' } : row));
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const current = !started ? jobs.find(job => job.id === activeId && job.status === 'ready' && job.result?.title) : undefined;
  if (current && stopTimes.current[current.id] && !announced.current[current.id]) {
    console.info('Floor scan stop-to-popup ms', Math.round(performance.now() - stopTimes.current[current.id]));
    announced.current[current.id] = true;
  }
  if (current?.result?.retail_prices?.length && stopTimes.current[current.id] && !priceAnnounced.current[current.id]) {
    console.info('Floor scan stop-to-retail ms', Math.round(performance.now() - stopTimes.current[current.id]));
    priceAnnounced.current[current.id] = true;
  }
  const result = current?.result || {};
  const retail = result.retail_prices?.[0];
  const retailAge = now - Date.parse(result.retail_started_at || result.identified_at || current?.created_at || '');
  const retailWaiting = !result.retail_ready && retailAge < 20_000;
  const options = distinctOptions(result);
  return <section className="card p-4 my-4">
    <h2 className="text-title">Video scan</h2>
    <p className="text-quiet">Film the item, label and box for at least 5 seconds. Hold still on the front and another side; speak any defects.</p>
    <video ref={preview} className="w-full rounded-lg mt-3" autoPlay muted playsInline style={{ display: started ? 'block' : 'none' }} />
    <div className="flex gap-2 mt-3">
      {!started ? <button type="button" className="btn-accent" disabled={busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Scan'}</button>
        : <button type="button" className="btn-accent" onClick={() => recording.current?.stop()}>Finish scan</button>}
    </div>
    {started && <p className="text-quiet">Recording; stops automatically at 20 seconds.</p>}
    {!current && !started && jobs.some(job => !timedOut(job, now) && (job.status === 'processing' || job.status === 'queued')) &&
      <p className="text-quiet mt-3">Identifying… You can start another scan.</p>}
    {savedSku && <div role="status" className="mt-3"><strong className="text-title font-mono">SKU {savedSku}</strong>
      <p>Write this on the unit. Ready for the next scan.</p><Link to={`/inventory/${savedSku}`}>Edit details</Link></div>}
    {error && <p role="alert" className="text-floor-danger mt-3">{error}</p>}
    {jobs.some(job => job.status === 'failed' || timedOut(job, now)) && <p className="text-quiet">A scan needs attention. Retry it below or use Manual Receive.</p>}
    {jobs.some(job => pendingStatuses.includes(job.status)) &&
      <div className="mt-4 grid gap-2"><h3 className="text-title">Pending scans</h3>
        {jobs.filter(job => pendingStatuses.includes(job.status)).map(job =>
          <div key={job.id} className="flex items-center gap-2 border border-floor-line p-2">
            <button type="button" className="flex-1 text-left" disabled={job.status !== 'ready'}
              onClick={() => { setActiveId(job.id); setError(''); }}>
              <strong>{job.result?.title || 'Scan'}</strong><span className="block text-quiet text-sm">
                {job.status === 'ready' ? 'Tap to finish' : job.status === 'failed' ? 'Identification failed; retry this recording' :
                  timedOut(job, now) ? 'Identification timed out; retry this recording' : 'Identifying…'}
              </span></button>
            {(job.status === 'failed' || timedOut(job, now)) && <button type="button" className="btn-text" onClick={() => void retry(job)}>Retry</button>}
            <button type="button" className="btn-text" onClick={() => void discard(job)}>{confirmDiscardId === job.id ? 'Confirm discard' : 'Discard'}</button>
          </div>)}</div>}
    {current && <div role="dialog" aria-modal="true" aria-label="Scan result"
      className="video-scan-modal">
      <div className="video-scan-modal-panel grid gap-4">
        {options.length >= 2 ? <><h3 className="text-title">Which product is it?</h3>
          {options.slice(0, 3).map(option =>
            <button type="button" key={option.index} className={`field text-left flex items-center gap-3 ${choices[current.id] === option.index ? 'ring-2' : ''}`}
              onClick={() => {setChoices(previous => ({ ...previous, [current.id]: option.index }));
                setChoosing(current.id);
                void post('video-scan-choice',current.id,{index:option.index}).catch(cause=>setError(cause.message))
                  .finally(()=>setChoosing(null));}}>
              {(option.thumbnail_data_url || ownThumb) &&
                <img src={option.thumbnail_data_url || ownThumb} alt={option.thumbnail_data_url ? option.label : 'Your scan photo'}
                  className="w-14 h-14 object-cover rounded" />}
              <span>{option.label}</span>
            </button>)}</> : null}
        <h3 className="text-title">{result.options?.[choices[current.id]]?.title || result.title}</h3>
        {retail ? <p>{retail.approximate ? 'Closest: ' : 'Sells for up to '}
          <strong>{dollars(retail.price_cents)}{retail.pack_size && retail.pack_size > 1
            ? ` for ${retail.pack_size}-pack (~${dollars(Math.round(retail.price_cents / retail.pack_size))} each)` : ''}</strong>
          {' '}at {retail.store} <a href={retail.url} target="_blank" rel="noreferrer">View price ↗</a></p>
          : <p className="text-quiet">{retailWaiting ? 'Looking up retail price…' : "Couldn't find a retail price"}</p>}
        {!retail && !retailWaiting && <button type="button" className="btn-text" onClick={() =>
          void post('video-scan-retry-price', current.id).catch(cause => setError(cause.message))}>Retry price lookup</button>}
        <label>How much do you want to sell it for?
          <input className="field mt-2" type="text" inputMode="decimal" placeholder="$"
            value={prices[current.id] || ''} onChange={event => {
              if (moneyPattern.test(event.target.value)) setPrices(previous => ({ ...previous, [current.id]: event.target.value }));
            }} onBlur={() => setPrices(previous => {
              const value = previous[current.id]; return value && parseMoneyToCents(value) != null
                ? { ...previous, [current.id]: (Number(value) || 0).toFixed(2) } : previous;
            })} />
        </label>
        <label>What did you pay for it? <span className="text-quiet">(optional)</span>
          <input className="field mt-2" type="text" inputMode="decimal" placeholder="$"
            value={costs[current.id] || ''} onChange={event => {
              if (moneyPattern.test(event.target.value)) setCosts(previous => ({ ...previous, [current.id]: event.target.value }));
            }} />
        </label>
        <button type="button" className="btn-accent" disabled={saving === current.id}
          onClick={() => void save(current)}>{saving === current.id ? 'Saving…' : 'Save & next'}</button>
        <button type="button" className="btn-text text-sm" disabled={saving === current.id}
          onClick={() => void save(current, true)}>Edit details after saving</button>
        <div className="flex justify-between gap-3 border-t border-floor-line pt-3">
          <button type="button" className="btn-text" disabled={saving === current.id} onClick={() => setActiveId(null)}>Skip for now</button>
          <button type="button" className="btn-text text-floor-danger" disabled={saving === current.id}
            onClick={() => void discard(current)}>{confirmDiscardId === current.id ? 'Confirm discard' : 'Cancel / Discard'}</button>
        </div>
      </div>
    </div>}
  </section>;
}
