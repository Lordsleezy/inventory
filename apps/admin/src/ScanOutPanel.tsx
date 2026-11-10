import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';
import { decodeBarcodeFile } from './ReceivePanel';
import { shouldQueueScan } from './scanQueue';
import { shipBundleRest } from './bundleShip';

type TodayRow = {
  id: string; order_id: string; sku?: string; title?: string;
  scanned_at: string; scanned_by_name?: string; scan_mode: string;
};
type OpenRow = {
  id: string; order_no?: string; sku?: string; title?: string;
  packaged_at?: string; channel?: string; location_code?: string | null;
};
type Lookup = {
  ok?: boolean; error?: string; sku?: string; title?: string;
  shipped_at?: string; scanned_out_at?: string;
  order?: { id: string; sku?: string; title?: string; shipped_at?: string };
};

function scanMessage(row: Lookup) {
  const title = row.title || row.order?.title || '';
  const sku = row.sku || row.order?.sku || '';
  const who = [title, sku ? `SKU ${sku}` : ''].filter(Boolean).join(' · ');
  if (row.error === 'not_found') return 'No packaged order matches that scan. Nothing was changed.';
  if (row.error === 'not_packaged') return `Not packaged yet${who ? `. ${who} is still in To ship. Pack it first.` : '. Pack it first.'}`;
  if (row.error === 'scanned_twice' || (row.error === 'already_shipped' && row.scanned_out_at && Date.now() - new Date(row.scanned_out_at).getTime() < 120_000)) {
    return `Scanned twice. ${who || 'That package'} was already scanned out a moment ago.`;
  }
  if (row.error === 'already_shipped') {
    const when = row.shipped_at ? new Date(row.shipped_at).toLocaleString() : '';
    return `Already shipped. ${who}${when ? ` shipped ${when}` : ''}.`;
  }
  if (row.error === 'not_shippable') return 'Cancelled or returned. Nothing was changed.';
  return row.error || 'Scan failed. Nothing was changed.';
}

function buzz(ok: boolean) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 880 : 180;
    g.gain.value = 0.08;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(() => { o.stop(); void ctx.close(); }, ok ? 90 : 220);
  } catch { /* optional */ }
  if ('vibrate' in navigator) navigator.vibrate(ok ? 40 : [30, 40, 30]);
}

type Props = {
  client: SupabaseClient;
  storeId: string;
  stamp?: (s: string) => string;
  appMode?: boolean;
  mode?: 'ship' | 'package';
  onClose?: () => void;
};

export function ScanOutPanel({ client, stamp = (s) => s, appMode, mode = 'ship', onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const queue = useRef<string[]>([]);
  const last = useRef<{ code: string; at: number } | null>(null);
  const running = useRef(false);
  const [today, setToday] = useState<TodayRow[]>([]);
  const [open, setOpen] = useState<OpenRow[]>([]);
  const [barcode, setBarcode] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<'ok' | 'err' | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; sku: string } | null>(null);
  const [note, setNote] = useState('');
  const [noteTone, setNoteTone] = useState<'ok' | 'err'>('err');
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const [camera, setCamera] = useState(false);
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    const [t, o] = await Promise.all([
      client.rpc('portal_scan_out_today'),
      client.rpc('portal_scan_out_packaged_open'),
    ]);
    if (!t.error) setToday((t.data || []) as TodayRow[]);
    if (!o.error) setOpen((o.data || []) as OpenRow[]);
  }, [client]);

  useEffect(() => {
    void refresh().then(() => {
      /* count comes from today's ship rows after load */
    });
    const id = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const n = today.filter((r) => r.scan_mode === mode).length;
    setCount(n);
  }, [today, mode]);

  useEffect(() => { if (!camera) inputRef.current?.focus(); }, [camera, busy]);

  async function commitOne(raw: string) {
    const code = raw.trim();
    if (!code) return;
    setBusy(true);
    setError('');
    setFlash(null);
    try {
      const lookup = await client.rpc('portal_scan_out_lookup', { p_barcode: code });
      const row = (lookup.data || null) as Lookup | null;
      if (lookup.error) throw new Error(lookup.error.message);
      if (!row || row.ok === false) {
        buzz(false);
        setFlash('err');
        setNoteTone('err');
        setNote(scanMessage(row || { error: 'not_found' }));
        setConfirm(null);
        return;
      }
      const commit = await client.rpc('portal_scan_out_commit', { p_barcode: code, p_mode: mode });
      if (commit.error) throw new Error(commit.error.message);
      const body = commit.data as { ok?: boolean; error?: string; sku?: string; title?: string; order_id?: string; shipped_at?: string; scanned_out_at?: string };
      if (body?.ok === false) {
        buzz(false);
        setFlash('err');
        setNoteTone('err');
        setNote(scanMessage(body));
        setConfirm(null);
        return;
      }
      const title = body.title || row.order?.title || 'Item';
      const sku = body.sku || row.order?.sku || '';
      buzz(true);
      setFlash('ok');
      setConfirm({ title, sku });
      const extra = mode === 'ship' && body.order_id ? await shipBundleRest(client, body.order_id, code) : '';
      setNote(extra);
      setBarcode('');
      await refresh();
    } catch (e) {
      setError(errText(e));
      buzz(false);
      setFlash('err');
    } finally {
      setBusy(false);
      window.setTimeout(() => setFlash(null), 280);
      inputRef.current?.focus();
    }
  }

  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        const code = queue.current.shift()!;
        await commitOne(code);
      }
    } finally {
      running.current = false;
      if (queue.current.length) void drain();
    }
  }, [mode, client]);

  function enqueue(raw: string) {
    const code = raw.trim();
    const now = Date.now();
    if (!shouldQueueScan(code, last.current, now)) {
      setNoteTone('err');
      setNote('Scanned twice. That code was already scanned a moment ago.');
      buzz(false);
      return;
    }
    last.current = { code, at: now };
    queue.current.push(code);
    setBarcode('');
    void drain();
  }

  async function undoLast() {
    setBusy(true);
    setError('');
    try {
      const { data, error: e } = await client.rpc('portal_scan_out_undo');
      if (e) throw new Error(e.message);
      const body = data as { ok?: boolean; error?: string; title?: string; sku?: string };
      if (!body?.ok) {
        setNoteTone('err');
        setNote('Could not undo. Nothing was changed.');
        return;
      }
      setConfirm(null);
      setNoteTone('ok');
      setNote(`Undone · ${body.title || 'last scan'}${body.sku ? ` · SKU ${body.sku}` : ''}`);
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function closePickup() {
    setClosing(true);
    setError('');
    try {
      const { error: e } = await client.rpc('portal_close_pickup', { p_note: null });
      if (e) throw new Error(e.message);
      setNoteTone('ok');
      setNote('Pickup closed for today.');
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setClosing(false);
    }
  }

  const todayRows = today.filter((r) => r.scan_mode === mode).slice(0, 8);

  return (
    <section className={`panel scan-out-panel${appMode ? ' scan-out-app' : ''}${flash ? ` scan-out-flash-${flash}` : ''}`}>
      <div className="scan-out-nav">
        <button type="button" onClick={onClose}>Back</button>
        <div className="scan-out-title">{mode === 'package' ? 'Pack scan' : 'Scan out'}</div>
        <div className="scan-out-count" role="status">
          <span>Scanned out today</span>
          <strong>{count}</strong>
        </div>
      </div>

      {camera ? (
        <ScanCamera
          onCode={(code) => enqueue(code)}
          onClose={() => setCamera(false)}
          confirm={confirm}
          onUndo={() => void undoLast()}
        />
      ) : (
        <>
          <form className="scan-out-field" onSubmit={(e) => { e.preventDefault(); enqueue(barcode); }}>
            <input
              ref={inputRef}
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              enterKeyHint="go"
              placeholder="Scan label barcode"
              aria-label="Scan label barcode"
            />
          </form>
          <div className="scan-out-actions">
            <button type="button" className="scan-out-outline" disabled={busy} onClick={() => setCamera(true)}>Use camera</button>
            <button type="button" className="scan-out-outline" onClick={() => { inputRef.current?.focus(); }}>Type SKU</button>
          </div>
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" aria-hidden tabIndex={-1}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              void decodeBarcodeFile(file).then((code) => {
                if (code) enqueue(code);
                else { setNoteTone('err'); setNote('Could not read that photo. Nothing was changed.'); buzz(false); }
              });
            }} />
        </>
      )}

      {confirm && !camera && (
        <div className="scan-out-confirm" role="status">
          <div>
            <strong>Shipped · {confirm.title}</strong>
            <span>SKU {confirm.sku} · just now</span>
          </div>
          <button type="button" className="scan-out-outline" disabled={busy} onClick={() => void undoLast()}>Undo</button>
        </div>
      )}
      {note && <p className={noteTone === 'err' ? 'scan-out-err' : 'scan-out-ok'} role="status">{note}</p>}
      {error && <p className="scan-out-err" role="alert">{error}</p>}

      {mode === 'ship' && (
        <div className="scan-out-waiting">
          <p className="scan-out-kicker">To scan out · {open.length}</p>
          {open.length === 0 && <p className="scan-out-empty">Everything packaged has been scanned out.</p>}
          <ul>
            {open.map((o) => (
              <li key={o.id}>
                <span className="scan-out-thumb">photo</span>
                <span>
                  <strong>{o.title || o.order_no || 'Order'}</strong>
                  <span className="scan-out-sku">SKU <b>{o.sku || '—'}</b></span>
                  <span className="scan-out-meta">{[o.channel || 'Order', o.location_code || 'No location'].join(' · ')}</span>
                </span>
              </li>
            ))}
          </ul>
          <button type="button" className="scan-out-quiet" disabled={closing} onClick={() => void closePickup()}>
            {closing ? 'Closing…' : 'Close out pickup'}
          </button>
        </div>
      )}

      {todayRows.length > 0 && (
        <div className="scan-out-waiting">
          <p className="scan-out-kicker">Scanned out today</p>
          <ul>
            {todayRows.map((r, i) => (
              <li key={r.id}>
                <span>
                  <strong>Shipped · {r.title || r.sku || 'Order'}</strong>
                  <span className="scan-out-meta">{r.sku ? `SKU ${r.sku} · ` : ''}{stamp(r.scanned_at)}</span>
                </span>
                {i === 0 && <button type="button" className="scan-out-outline" disabled={busy} onClick={() => void undoLast()}>Undo</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ScanCamera({ onCode, onClose, confirm, onUndo }: {
  onCode: (code: string) => void;
  onClose: () => void;
  confirm: { title: string; sku: string } | null;
  onUndo: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopRef = useRef(false);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    stopRef.current = false;
    let stream: MediaStream | null = null;
    const Detector = (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => { detect: (src: ImageBitmapSource) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.setAttribute('playsinline', 'true');
        await video.play();
        if (!Detector) return;
        const detector = new Detector({ formats: ['code_128', 'code_39', 'codabar', 'itf', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code'] });
        while (!stopRef.current) {
          const bitmap = await createImageBitmap(video);
          try {
            const codes = await detector.detect(bitmap);
            const raw = codes[0]?.rawValue;
            if (raw && !stopRef.current) onCodeRef.current(raw);
          } finally { bitmap.close(); }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch { /* camera denied — photo fallback stays on the parent */ }
    })();
    return () => {
      stopRef.current = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="scan-out-camera">
      <div className="scan-out-view">
        <video ref={videoRef} muted playsInline />
        <span className="scan-out-bracket tl" /><span className="scan-out-bracket tr" />
        <span className="scan-out-bracket bl" /><span className="scan-out-bracket br" />
      </div>
      <p className="scan-out-meta">Point at the shipping label barcode</p>
      {confirm && (
        <div className="scan-out-confirm" role="status">
          <div>
            <strong>Shipped · {confirm.title}</strong>
            <span>SKU {confirm.sku} · scanned out today</span>
          </div>
          <button type="button" className="scan-out-outline" onClick={onUndo}>Undo</button>
        </div>
      )}
      <button type="button" className="scan-out-done" onClick={onClose}>Done scanning</button>
      <p className="scan-out-meta">Keeps scanning until you tap Done. A short buzz confirms each one.</p>
    </div>
  );
}
