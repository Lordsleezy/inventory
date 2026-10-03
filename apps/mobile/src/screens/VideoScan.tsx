import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { floorCloud } from '@floor/cloud';
import { parseMoneyToCents } from '@floor/store';
import { authHeader, functionsUrl } from '../functions';
import { startVideoScan } from '../video-scan-capture';

type Price = { store: string; price_cents: number; url: string; pack_size?: number; approximate?: boolean; product_name?: string };
type Identity = { title?: string; brand?: string; model?: string; color?: string;
  options?: { label: string; title: string; brand: string; model: string; color: string }[];
  retail_prices?: Price[]; msrp_cents?: number; retail_ready?: boolean };
type Job = { id: string; status: string; result: Identity | null; error: string | null; sku: string | null; created_at: string };
const moneyPattern = /^\d*(?:\.\d{0,2})?$/;
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
async function post(path: string, id: string) {
  const response = await fetch(functionsUrl(path), { method: 'POST', headers: {
    ...await authHeader(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Scan request failed (${response.status})`);
  return body;
}

export function VideoScan() {
  const navigate = useNavigate();
  const preview = useRef<HTMLVideoElement>(null);
  const recording = useRef<{ stop: () => void; abort: () => void } | null>(null);
  const uploads = useRef<Record<string, Promise<void> | undefined>>({});
  const early = useRef<Record<string, Promise<void> | undefined>>({});
  const stopTimes = useRef<Record<string, number>>({});
  const announced = useRef<Record<string, boolean>>({});
  const [started, setStarted] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedSku, setSavedSku] = useState('');
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [ownThumb, setOwnThumb] = useState('');

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const { data } = await floorCloud().from('video_scan_jobs')
        .select('id,status,result,error,sku,created_at').order('created_at', { ascending: false }).limit(12);
      if (active && data) setJobs(data as Job[]);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 900);
    return () => { active = false; window.clearInterval(timer); recording.current?.abort(); };
  }, []);

  async function start() {
    setError(''); setSavedSku(''); setBusy(true);
    try {
      const budget = await floorCloud().rpc('video_scan_budget');
      if (budget.error) throw budget.error;
      const limit = budget.data as { spent_usd: number; reserved_usd: number; monthly_cap_usd: number };
      if (Number(limit.spent_usd) + Number(limit.reserved_usd) + 1 > Number(limit.monthly_cap_usd))
        throw new Error('Monthly AI scan cap reached. Use manual Receive or ask an admin to raise it.');
      const { data: storeId, error: storeError } = await floorCloud().rpc('current_store_id');
      if (storeError || !storeId) throw storeError || new Error('Store login required');
      const { data: auth } = await floorCloud().auth.getUser();
      if (!auth.user?.id) throw new Error('Sign in to scan');
      const id = crypto.randomUUID(), prefix = `${storeId}/${auth.user.id}/${id}`;
      const extension = MediaRecorder.isTypeSupported('video/mp4') ? 'mp4' : 'webm';
      const bucket = floorCloud().storage.from('video-scan-staging');
      const stillPaths = Array.from({ length: 4 }, (_, index) => `${prefix}/still-${index}.jpg`);
      let earlyStills: Blob[] = [];
      const beginIdentify = (stills: Blob[]) => {
        if (early.current[id]) return;
        earlyStills = stills;
        if (stills[0]) setOwnThumb(URL.createObjectURL(stills[0]));
        early.current[id] = (async () => {
          const sent = await Promise.all(stills.map((blob, index) =>
            bucket.upload(stillPaths[index], blob, { contentType: 'image/jpeg' })));
          for (const item of sent) if (item.error) throw item.error;
          const created = await floorCloud().rpc('video_scan_create', {
            p_id: id, p_video_path: `${prefix}/video.${extension}`, p_still_paths: stillPaths });
          if (created.error) throw created.error;
          setJobs(previous => [{ id, status: 'processing', result: null, error: null, sku: null,
            created_at: new Date().toISOString() }, ...previous]);
          await post('video-scan-start', id);
        })();
        early.current[id]?.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
      };
      if (!preview.current) return;
      recording.current = await startVideoScan(preview.current, scan => {
        recording.current = null; setStarted(false); stopTimes.current[id] = performance.now();
        uploads.current[id] = (async () => {
          if (scan.seconds < 10 || scan.video.size < 50_000) throw new Error('Record at least 10 seconds.');
          if (scan.video.size > 15 * 1024 * 1024) throw new Error('Video is over 15 MB.');
          if (!early.current[id]) beginIdentify(scan.stills.slice(0, 2));
          // The full video is only needed after Save. Identification is already running from stills.
          const video = bucket.upload(`${prefix}/video.${extension}`, scan.video, { contentType: scan.mimeType });
          await early.current[id];
          const remaining = scan.stills.slice(earlyStills.length);
          const rest = await Promise.all(remaining.map((blob, index) =>
            bucket.upload(stillPaths[earlyStills.length + index], blob, { contentType: 'image/jpeg' })));
          for (const item of rest) if (item.error) throw item.error;
          const uploaded = await video;
          if (uploaded.error) throw uploaded.error;
        })();
        uploads.current[id].catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
      }, cause => { setError(cause.message); recording.current = null; setStarted(false); }, beginIdentify);
      setStarted(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function save(job: Job, editAfter = false) {
    const price = parseMoneyToCents(prices[job.id] || '');
    if (price === undefined || price === null || price <= 0) { setError('Enter your selling price.'); return; }
    const result = job.result || {};
    if (result.options?.length && choices[job.id] === undefined) { setError('Pick the matching product first.'); return; }
    const chosen = result.options?.[choices[job.id]];
    setSaving(job.id); setError('');
    try {
      await uploads.current[job.id];
      const draft = { ...result, ...(chosen || {}) };
      const { data, error: saveError } = await floorCloud().rpc('video_scan_receive', {
        p_id: job.id, p_draft: draft, p_ask_cents: price });
      if (saveError) throw saveError;
      const sku = (data as { sku: string }).sku;
      setSavedSku(sku);
      setJobs(previous => previous.map(row => row.id === job.id ? { ...row, status: 'saved', sku } : row));
      setPrices(previous => { const next = { ...previous }; delete next[job.id]; return next; });
      // These run after the unit exists; the user can immediately start the next scan.
      void post('video-scan-photos', job.id).catch(cause => setError(`SKU ${sku} saved; photos need retry: ${cause.message}`));
      void post('video-scan-enrich-start', job.id).catch(cause => setError(`SKU ${sku} saved; details need retry: ${cause.message}`));
      window.setTimeout(() => setSavedSku(current => current === sku ? '' : current), 12000);
      if (editAfter) navigate(`/inventory/${sku}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(null); }
  }

  const current = !started ? jobs.find(job => job.status === 'ready' && job.result?.title) : undefined;
  if (current && stopTimes.current[current.id] && !announced.current[current.id]) {
    console.info('Floor scan stop-to-popup ms', Math.round(performance.now() - stopTimes.current[current.id]));
    announced.current[current.id] = true;
  }
  const result = current?.result || {};
  const retail = result.retail_prices?.[0];
  return <section className="card p-4 my-4">
    <h2 className="text-title">Video scan</h2>
    <p className="text-quiet">Film the item, label and box for 10–20 seconds. Speak any defects.</p>
    <video ref={preview} className="w-full rounded-lg mt-3" autoPlay muted playsInline style={{ display: started ? 'block' : 'none' }} />
    <div className="flex gap-2 mt-3">
      {!started ? <button type="button" className="btn-accent" disabled={busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Scan'}</button>
        : <button type="button" className="btn-accent" onClick={() => recording.current?.stop()}>Finish scan</button>}
    </div>
    {started && <p className="text-quiet">Recording; stops automatically at 20 seconds.</p>}
    {!current && !started && jobs.some(job => job.status === 'processing' || job.status === 'queued') &&
      <p className="text-quiet mt-3">Identifying… You can start another scan.</p>}
    {savedSku && <div role="status" className="mt-3"><strong className="text-title font-mono">SKU {savedSku}</strong>
      <p>Write this on the unit. Ready for the next scan.</p><Link to={`/inventory/${savedSku}`}>Edit details</Link></div>}
    {error && <p role="alert" className="text-floor-danger mt-3">{error}</p>}
    {jobs.some(job => job.status === 'failed') && <p className="text-quiet">A scan failed. Manual Receive is available below.</p>}
    {current && <div role="dialog" aria-modal="true" aria-label="Scan result"
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="card w-full max-w-md p-5 grid gap-4">
        {result.options?.length ? <><h3 className="text-title">Which product is it?</h3>
          {result.options.slice(0, 3).map((option, index) =>
            <button type="button" key={index} className={`field text-left flex items-center gap-3 ${choices[current.id] === index ? 'ring-2' : ''}`}
              onClick={() => setChoices(previous => ({ ...previous, [current.id]: index }))}>
              {ownThumb && <img src={ownThumb} alt="Scan photo" className="w-14 h-14 object-cover rounded" />}
              <span>{option.label}</span>
            </button>)}</> : null}
        <h3 className="text-title">{result.options?.[choices[current.id]]?.title || result.title}</h3>
        {retail ? <p>{retail.approximate ? 'Closest: ' : 'Sells for up to '}
          <strong>{dollars(retail.price_cents)}{retail.pack_size && retail.pack_size > 1
            ? ` for ${retail.pack_size}-pack (~${dollars(Math.round(retail.price_cents / retail.pack_size))} each)` : ''}</strong>
          {' '}at {retail.store} <a href={retail.url} target="_blank" rel="noreferrer">View price ↗</a></p>
          : <p className="text-quiet">{result.retail_ready ? "Couldn't find a retail price" : 'Looking up retail price…'}</p>}
        <label>How much do you want to sell it for?
          <input className="field mt-2" type="text" inputMode="decimal" placeholder="$"
            value={prices[current.id] || ''} onChange={event => {
              if (moneyPattern.test(event.target.value)) setPrices(previous => ({ ...previous, [current.id]: event.target.value }));
            }} onBlur={() => setPrices(previous => {
              const value = previous[current.id]; return value && parseMoneyToCents(value) != null
                ? { ...previous, [current.id]: (Number(value) || 0).toFixed(2) } : previous;
            })} />
        </label>
        <button type="button" className="btn-accent" disabled={saving === current.id}
          onClick={() => void save(current)}>{saving === current.id ? 'Saving…' : 'Save & next'}</button>
        <button type="button" className="btn-text text-sm" disabled={saving === current.id}
          onClick={() => void save(current, true)}>Edit details after saving</button>
      </div>
    </div>}
  </section>;
}
