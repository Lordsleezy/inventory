import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
function compactTracking(value: string) {
  let n = String(value || '').replace(/\s+/g, '').toUpperCase();
  const wrapped = n.match(/^420\d{5}(9[2-5]\d{18,24})$/) || n.match(/^420\d{9}(9[2-5]\d{18,24})$/);
  if (wrapped) n = wrapped[1];
  const ups = n.match(/1Z[0-9A-Z]{16}/);
  if (ups) return ups[0];
  if (/^\d{34}$/.test(n)) return n.slice(-12);
  return n;
}
import { errText } from './errText';

type Stats = { packaged: number; scanned_today: number; day?: string };
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
  const [stats, setStats] = useState<Stats | null>(null);
  const [today, setToday] = useState<TodayRow[]>([]);
  const [open, setOpen] = useState<OpenRow[]>([]);
  const [barcode, setBarcode] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; title: string; sub?: string } | null>(null);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);

  const refresh = useCallback(async () => {
    const [s, t, o] = await Promise.all([
      client.rpc('portal_scan_out_stats'),
      client.rpc('portal_scan_out_today'),
      client.rpc('portal_scan_out_packaged_open'),
    ]);
    if (!s.error) setStats(s.data as Stats);
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

  const counter = useMemo(() => {
    const scanned = stats?.scanned_today ?? 0;
    const packaged = stats?.packaged ?? 0;
    return `${scanned} scanned / ${packaged} packaged`;
  }, [stats]);

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
        if (err.error === 'already_scanned') {
          beep(false);
          setFlash({ tone: 'err', title: 'Already scanned out', sub: `${stamp(err.scanned_at || '')}${err.scanned_by_name ? ` by ${err.scanned_by_name}` : ''}` });
        } else if (err.error === 'not_found') {
          beep(false);
          setFlash({ tone: 'err', title: 'Not found', sub: compactTracking(code) });
        } else if (err.error === 'not_shippable') {
          beep(false);
          setFlash({ tone: 'err', title: 'Order cancelled or returned' });
        } else {
          beep(false);
          setFlash({ tone: 'err', title: err.error || 'Scan failed' });
        }
        return;
      }
      const commit = await client.rpc('portal_scan_out_commit', { p_barcode: code, p_mode: mode });
      if (commit.error) throw new Error(commit.error.message);
      const body = commit.data as { ok?: boolean; error?: string; order_id?: string; can_mark_packaged?: boolean };
      if (body?.ok === false) {
        if (body.error === 'not_packaged' && body.can_mark_packaged) {
          beep(false);
          setFlash({ tone: 'err', title: 'Not packaged yet', sub: 'Mark packaged first, or scan at packing.' });
        } else if (body.error === 'already_scanned') {
          beep(false);
          setFlash({ tone: 'err', title: 'Already scanned' });
        } else {
          beep(false);
          setFlash({ tone: 'err', title: body.error || 'Could not record scan' });
        }
        return;
      }
      const order = (row as LookupOk).order;
      beep(true);
      setFlash({
        tone: 'ok',
        title: order.title || `Order ${order.order_no || ''}`.trim(),
        sub: order.sku ? `SKU ${order.sku}` : undefined,
      });
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
        <p className="scan-out-counter" role="status">{counter}</p>
        <p className="hint">Scan the shipping label barcode. USPS 420+ZIP wrappers normalize automatically.</p>
      </header>
      {flash && (
        <div className={`scan-out-flash scan-out-flash--${flash.tone}`} role="status">
          <strong>{flash.tone === 'ok' ? '✓' : '!'}</strong>
          <p>
            {flash.title}
            {flash.sub ? <><br /><span className="hint">{flash.sub}</span></> : null}
          </p>
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
          placeholder="Scan or type tracking number"
          disabled={busy}
        />
      </label>
      <button type="button" className="scan-out-commit secondary" disabled={busy || !barcode.trim()} onClick={() => void commitScan(barcode)}>
        {busy ? '…' : 'Record scan'}
      </button>

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
