import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decodeBarcodeFile, ReceivePanel } from '../ReceivePanel';
import { BundleReceive } from '../BundleReceive';
import { AppItemDetail } from './AppItemDetail';
import { ReceiveWorkStatus } from '../ReceiveWorkStatus';
import { isAndroid, isStandaloneApp } from './isAppMode';

type Props = {
  client: SupabaseClient;
  storeId: string;
  accessToken: string;
  staffMode?: boolean;
  onSaved: () => void;
};

/** Native Receive home; opens the shared ReceivePanel form after scan / camera / manual. */
export function AppReceive({ client, storeId, accessToken, staffMode = false, onSaved }: Props) {
  // Scope this layout to the store phone: an installed Android PWA signed in as
  // an active clerk. iPhone and desktop/admin Receive keep their current UI.
  const storePhoneMode = staffMode && isAndroid() && isStandaloneApp();
  const [phase, setPhase] = useState<'home' | 'form' | 'bundle'>('home');
  useEffect(() => {
    if (phase !== 'home') return;
    const raw = sessionStorage.getItem('floor:last-receive-timing');
    if (!raw) return;
    sessionStorage.removeItem('floor:last-receive-timing');
    const timing = JSON.parse(raw);
    requestAnimationFrame(() => console.info('receive_next_scan_ready', {
      tap_to_ready_ms: Math.round(performance.now() - timing.tappedAt), server_ms: timing.server_ms,
    }));
  }, [phase]);
  const [manual, setManual] = useState(false);
  const [pendingUpc, setPendingUpc] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState('');
  const [nextSku, setNextSku] = useState<string | null>(null);
  const [today, setToday] = useState<{ sku: string; title: string }[]>([]);
  const [editSku, setEditSku] = useState<string | null>(null);
  const homeCamera = useRef<HTMLInputElement>(null);

  function openForm(asManual: boolean) {
    setManual(asManual);
    setPhase('form');
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data } = await client.rpc(staffMode ? 'staff_receive_options' : 'portal_receive_options');
      if (alive && data?.next_sku) setNextSku(String(data.next_sku));
    })();
    return () => { alive = false; };
  }, [client, phase, staffMode]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const { data } = await client
        .from(staffMode ? 'units_pos' : 'units')
        .select('sku, title, brand, model, received_at')
        .eq('store_id', storeId)
        .gte('received_at', start.toISOString())
        .order('received_at', { ascending: false })
        .limit(30);
      if (!alive) return;
      setToday((data || []).map((u) => ({
        sku: u.sku,
        title: [u.brand, u.model].filter(Boolean).join(' ') || u.title || u.sku,
      })));
    })();
    return () => { alive = false; };
  }, [client, storeId, phase, staffMode]);

  if (phase === 'form') {
    return (
      <div className="app-receive-form">
        <ReceivePanel
          client={client}
          storeId={storeId}
          accessToken={accessToken}
          staffMode={staffMode}
          storePhoneMode={storePhoneMode}
          onSaved={() => {
            onSaved();
            setPendingUpc(null);
            setPhase('home');
          }}
          appChrome
          initialManual={manual}
          initialUpc={pendingUpc}
          onAppCancel={() => {
            setPendingUpc(null);
            setPhase('home');
          }}
        />
      </div>
    );
  }

  if (editSku) return <AppItemDetail client={client} storeId={storeId} accessToken={accessToken} sku={editSku} money={n => `$${(n / 100).toFixed(2)}`} staffMode={staffMode} canDelete={!staffMode} scannerInputReady onBack={() => setEditSku(null)} onChanged={() => { onSaved(); setEditSku(null); }} onSellInStore={() => setEditSku(null)} />;

  if (phase === 'bundle') {
    return <div className="app-receive-form">
      <div className="app-nav receive-app-nav">
        <button type="button" onClick={() => setPhase('home')}>Receive</button>
        <div className="app-nav-title">Bundle items</div>
        <span />
      </div>
      <BundleReceive client={client} lastReceived={today[0]?.sku} onSaved={onSaved} />
    </div>;
  }

  return (
    <>
      <div className="app-large-title app-receive-title">
        <h1>Receive</h1>
        <span className="app-scanner-status ok" title="Bluetooth keyboard scanner status is not exposed to Floor. Scan into the barcode field to test it.">
          <i />
          Scanner input ready
        </span>
      </div>

      <button type="button" className="app-scan-card" onClick={() => openForm(false)}>
        <strong>Scan a barcode</strong>
        <span>Next SKU {nextSku || '…'}</span>
      </button>

      <input
        ref={homeCamera}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setCameraError('');
          void decodeBarcodeFile(file).then((code) => {
            if (code) {
              setPendingUpc(code);
              openForm(false);
            } else {
              setCameraError('Couldn’t read a barcode from that photo. Try again or type the digits.');
              openForm(false);
            }
          });
        }}
      />

      <div className="app-actions" style={{ paddingTop: 0 }}>
        {/* Must open the file picker in this tap — deferred clicks are blocked on iOS. */}
        <button type="button" onClick={() => homeCamera.current?.click()}>Use camera</button>
        <button type="button" onClick={() => openForm(true)}>No barcode</button>
        {!staffMode && <button type="button" className="bundle-entry" onClick={() => setPhase('bundle')}>Bundle items</button>}
      </div>
      {cameraError && <p className="app-inline-error">{cameraError}</p>}
      <ReceiveWorkStatus client={client} accessToken={accessToken} />

      <p className="app-section-label">Received today</p>
      <div className="app-group">
        {today.length === 0 && <div className="app-empty-row">Nothing yet today</div>}
        {today.map((u) => (
          <button key={u.sku} type="button" className="app-row" onClick={() => setEditSku(u.sku)}>
            <span className="app-row-text">
              <strong>{u.title}</strong>
              <small>{u.sku}</small>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
