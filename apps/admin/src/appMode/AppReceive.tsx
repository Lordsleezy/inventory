import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { displayProductTitle } from '@floor/store';
import { ReceivePanel } from '../ReceivePanel';
import { ManifestSearchBox } from '../ManifestSearchBox';
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
  const [phase, setPhase] = useState<'home' | 'form' | 'bundle'>('form');
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
  const [entry, setEntry] = useState<'scan' | 'identify'>('scan');
  const [pendingUpc, setPendingUpc] = useState<string | null>(null);
  const [nextSku, setNextSku] = useState<string | null>(null);
  const [today, setToday] = useState<{ sku: string; title: string; location: string; at: string }[]>([]);
  const scanRef = useRef<HTMLInputElement>(null);
  const [editSku, setEditSku] = useState<string | null>(null);

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
        .select('sku, title, brand, model, received_at, location')
        .eq('store_id', storeId)
        .gte('received_at', start.toISOString())
        .order('received_at', { ascending: false })
        .limit(30);
      if (!alive) return;
      setToday((data || []).map((u) => ({
        sku: u.sku,
        title: displayProductTitle({ title: u.title, brand: u.brand, model: u.model, fallback: u.sku }),
        location: u.location || '',
        at: u.received_at,
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
            setManual(false);
          }}
          appChrome
          initialManual={manual}
          initialEntry={entry}
          initialUpc={pendingUpc}
          onAppCancel={() => {
            setPendingUpc(null);
            setManual(false);
            setEntry('scan');
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
    <div className="receive-home">
      <h1>Receive</h1>
      <p>Next SKU <strong>{nextSku || '…'}</strong></p>
      <button type="button" onClick={() => { setEntry('scan'); openForm(false); }}>Scan</button>
      <form onSubmit={(e) => { e.preventDefault(); const code = scanRef.current?.value.trim(); if (!code) return; setEntry('scan'); setPendingUpc(code); openForm(false); }}>
        <label>Type UPC
          <input ref={scanRef} aria-label="Type UPC" placeholder="Type the digits" autoComplete="off" enterKeyHint="go" inputMode="numeric" />
        </label>
        <button type="submit">Look up</button>
      </form>
      <button type="button" onClick={() => { setPendingUpc(null); setEntry('identify'); openForm(false); }}>No barcode</button>
      <ManifestSearchBox client={client} onPick={line => {
        const code = line.upc_normalized || line.item_number;
        if (!code) return;
        setEntry('scan');
        setPendingUpc(code);
        openForm(false);
      }} />
      {!staffMode && <button type="button" onClick={() => setPhase('bundle')}>Bundle items</button>}
      <ReceiveWorkStatus client={client} accessToken={accessToken} />

      <p className="app-section-label">Received today</p>
      <div className="app-group">
        {today.length === 0 && <div className="app-empty-row">Nothing yet today</div>}
        {today.map((u) => (
          <button key={u.sku} type="button" className="app-row" onClick={() => setEditSku(u.sku)}>
            <span className="app-row-text">
              <strong className="app-row-title">{u.title}</strong>
              <small className="app-sku-line"><span className="lbl">SKU</span> <strong>{u.sku}</strong>{u.location ? ` · ${u.location}` : ''}</small>
            </span>
            <span className="app-row-when">{u.at ? new Date(u.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
