import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decodeBarcodeFile, ReceivePanel } from '../ReceivePanel';
import { BundleReceive } from '../BundleReceive';
import { AppItemDetail } from './AppItemDetail';

type Props = {
  client: SupabaseClient;
  storeId: string;
  accessToken: string;
  staffMode?: boolean;
  onSaved: () => void;
};

/** Native Receive home; opens the shared ReceivePanel form after scan / camera / manual. */
export function AppReceive({ client, storeId, accessToken, staffMode = false, onSaved }: Props) {
  const [phase, setPhase] = useState<'home' | 'form' | 'bundle'>('home');
  const [manual, setManual] = useState(false);
  const [pendingUpc, setPendingUpc] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState('');
  const [scannerOk, setScannerOk] = useState(true);
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
    const onHid = () => setScannerOk(true);
    window.addEventListener('keydown', onHid, { once: true });
    // Bluetooth wedges look like fast keyboard input; stay optimistic green on store phone.
    const t = window.setTimeout(() => setScannerOk(true), 0);
    return () => { alive = false; window.clearTimeout(t); window.removeEventListener('keydown', onHid); };
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

  if (editSku) return <AppItemDetail client={client} storeId={storeId} accessToken={accessToken} sku={editSku} money={n => `$${(n / 100).toFixed(2)}`} staffMode={staffMode} canDelete={!staffMode} onBack={() => setEditSku(null)} onChanged={() => { onSaved(); setEditSku(null); }} onSellInStore={() => setEditSku(null)} />;

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
        <span className={`app-scanner-status ${scannerOk ? 'ok' : 'warn'}`}>
          <i />
          {scannerOk ? 'Scanner connected' : 'Scanner not connected'}
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
