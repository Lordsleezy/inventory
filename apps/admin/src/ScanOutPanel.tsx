import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';
import { decodeBarcodeFile } from './ReceivePanel';

type TodayRow = {
  id: string; order_id: string; sku?: string; title?: string; tracking_normalized: string;
  scanned_at: string; scanned_by_name?: string; scan_mode: string;
};
type OpenRow = {
  id: string; order_no?: string; sku?: string; title?: string; tracking_number?: string;
  packaged_at?: string; channel?: string;
};
type LookupOk = {
  ok: true;
  order: { id: string; order_no?: string; sku?: string; title?: string; packaged_at?: string; shipped_at?: string };
};
type LookupErr = { ok: false; error: string; scanned_at?: string; scanned_by_name?: string; order_id?: string; can_mark_packaged?: boolean };

function scanOutMessage(error?: string) {
  if (error === 'not_found') return { title: 'No matching order', sub: 'Nothing was changed.' };
  if (error === 'not_packaged') return { title: 'Not packaged yet', sub: 'Nothing was changed.' };
  if (error === 'already_shipped' || error === 'already_scanned') return { title: 'Already shipped', sub: 'Nothing was changed.' };
  if (error === 'not_shippable') return { title: 'Cancelled or returned', sub: 'Nothing was changed.' };
  return { title: error || 'Scan failed', sub: 'Nothing was changed.' };
}

function beep(ok: boolean) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.value = 0.08;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(() => { o.stop(); void ctx.close(); }, ok ? 120 : 200);
  } catch { /* optional */ }
  if (ok && 'vibrate' in navigator) navigator.vibrate(40);
}

type Props = {
  client: SupabaseClient;
  storeId: string;
  stamp?: (s: string) => string;
  appMode?: boolean;
  /** `ship` = carrier pickup; `package` = label on box at pack station */
  mode?: 'ship' | 'package';
  onClose?: () => void;
};

export function ScanOutPanel({ client, stamp = (s) => s, appMode, mode = 'ship', onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [session, setSession] = useState<{ title: string; sku: string }[]>([]);
  const [today, setToday] = useState<TodayRow[]>([]);
  const [open, setOpen] = useState<OpenRow[]>([]);
  const [barcode, setBarcode] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; title: string; sub?: string } | null>(null);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);

  const refresh = useCallback(async () => {
    const [t, o] = await Promise.all([
      client.rpc('portal_scan_out_today'),
      client.rpc('portal_scan_out_packaged_open'),
    ]);
    if (!t.error) setToday((t.data || []) as TodayRow[]);
    if (!o.error) setOpen((o.data || []) as OpenRow[]);
  }, [client]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function commitScan(raw: string) {
    const code = raw.trim();
    if (!code || busy) return;
    setBusy(true);
    setError('');
    setFlash(null);
  try {
      const lookup = await client.rpc('portal_scan_out_lookup', { p_barcode: code });
      const row = lookup.data as LookupOk | LookupErr | null;
      if (lookup.error) throw new Error(lookup.error.message);
      if (!row || row.ok === false) {
        const err = row as LookupErr;
        beep(false);
        setFlash({ tone: 'err', ...scanOutMessage(err.error) });
        return;
      }
      const commit = await client.rpc('portal_scan_out_commit', { p_barcode: code, p_mode: mode });
      if (commit.error) throw new Error(commit.error.message);
      const body = commit.data as { ok?: boolean; error?: string; order_id?: string; sku?: string; title?: string };
      if (body?.ok === false) {
        beep(false);
        setFlash({ tone: 'err', ...scanOutMessage(body.error) });
        return;
      }
      const order = (row as LookupOk).order;
      const title = body.title || order.title || 'Item';
      const sku = body.sku || order.sku || '';
      beep(true);
      setFlash({ tone: 'ok', title: `Shipped: ${title}${sku ? `, SKU ${sku}` : ''}` });
      setSession((prev) => [{ title, sku }, ...prev]);
      setBarcode('');
      await refresh();
    } catch (e) {
      setError(errText(e));
      beep(false);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function undoLast() {
    setBusy(true);
    setError('');
    try {
      const { data, error: e } = await client.rpc('portal_scan_out_undo');
      if (e) throw new Error(e.message);
      const body = data as { ok?: boolean; error?: string; title?: string; sku?: string };
      if (!body?.ok) {
        setFlash({ tone: 'err', title: 'Could not undo', sub: 'Nothing was changed.' });
        return;
      }
      setSession((prev) => prev.slice(1));
      setFlash({ tone: 'ok', title: `Undone: ${body.title || 'last scan'}${body.sku ? `, SKU ${body.sku}` : ''}` });
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
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setClosing(false);
    }
  }

  return (
    <section className={`panel scan-out-panel${appMode ? ' scan-out-app' : ''}`}>
      {onClose && (
        <div className="app-nav">
          <button type="button" onClick={onClose}>Back</button>
          <div className="app-nav-title">{mode === 'package' ? 'Pack scan' : 'Scan out'}</div>
          <span />
        </div>
      )}
      <header className="scan-out-head">
        <p className="scan-out-counter" role="status">Scanned out today: {session.length}</p>
        <p className="hint">Scan the shipping label or the SKU. The field stays ready for the next one.</p>
      </header>
      {flash && (
        <div className={`scan-out-flash scan-out-flash--${flash.tone}`} role="status">
          <strong>{flash.tone === 'ok' ? '✓' : '!'}</strong>
          <p>
            {flash.title}
            {flash.sub ? <><br /><span className="hint">{flash.sub}</span></> : null}
          </p>
          {flash.tone === 'ok' && session.length > 0 && (
            <button type="button" className="text-button" disabled={busy} onClick={() => void undoLast()}>Undo</button>
          )}
          <button type="button" className="text-button" onClick={() => setFlash(null)}>Dismiss</button>
        </div>
      )}
      {error && <div className="alert" role="alert">{error}</div>}
      <label className="scan-out-input">
        Tracking barcode
        <input
          ref={inputRef}
          value={barcode}
          onChange={e => setBarcode(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commitScan(barcode);
            }
          }}
          autoComplete="off"
          inputMode="text"
          placeholder="Scan tracking or SKU"
          disabled={busy}
        />
      </label>
      <button type="button" className="scan-out-commit secondary" disabled={busy || !barcode.trim()} onClick={() => void commitScan(barcode)}>
        {busy ? '…' : 'Record scan'}
      </button>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" aria-hidden tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          void decodeBarcodeFile(file).then((code) => {
            if (code) void commitScan(code);
            else setFlash({ tone: 'err', title: 'Could not read that photo', sub: 'Nothing was changed.' });
          });
        }} />
      <button type="button" className="secondary" disabled={busy} onClick={() => cameraRef.current?.click()}>Use camera</button>
      {session.length > 0 && (
        <div>
          <p className="app-section-label">This session</p>
          <ul className="scan-out-list">
            {session.map((row, i) => <li key={`${row.sku}-${i}`}><strong>{row.title}</strong>{row.sku ? <> · SKU {row.sku}</> : null}</li>)}
          </ul>
        </div>
      )}

      {mode === 'ship' && (
        <>
          <details className="scan-out-open" open={open.length > 0}>
            <summary>Packaged but not scanned out ({open.length})</summary>
            <ul className="scan-out-list">
              {open.map(o => (
                <li key={o.id}>
                  <strong>{o.title || o.order_no}</strong>
                  {o.sku ? <> · SKU {o.sku}</> : null}
                  {o.tracking_number ? <div className="hint">{o.tracking_number}</div> : null}
                </li>
              ))}
            </ul>
          </details>
          <div className="scan-out-actions">
            <button type="button" className="secondary" disabled={closing} onClick={() => void closePickup()}>
              {closing ? 'Closing…' : 'Close out pickup'}
            </button>
          </div>
        </>
      )}

      <details className="scan-out-today" open>
        <summary>Today&apos;s scans ({today.filter(r => r.scan_mode === mode).length})</summary>
        <ul className="scan-out-list">
          {today.filter(r => r.scan_mode === mode).map(r => (
            <li key={r.id}>
              <strong>{r.title || r.tracking_normalized}</strong>
              {r.sku ? <> · {r.sku}</> : null}
              <span className="hint"> · {stamp(r.scanned_at)}{r.scanned_by_name ? ` · ${r.scanned_by_name}` : ''}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
