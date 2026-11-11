import { useMemo, useState, type RefObject } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { displayOrderTitle } from '../orderDisplay';
import { locationParts } from '../locationOrder';
import { locationMenuLabel, type LocationChoice } from '../locationPlace';
import {
  hasLabel, orderCanMarkPackaged, orderCanStepBack, orderNeedsLabel, orderNeedsWeightVerify, orderStage,
  carrierTrackUrl, type OrderStage,
} from '../orderStage';
import { listThumbPhoto, type UnitPhoto } from '../unitPhotos';
import type { WebOrder } from '../OrdersPage';
import { UnitListThumb } from '../UnitListThumb';
import { LabelTrackingPicker, LabelTrackingResult } from '../LabelTrackingResult';
import { LabelTrackingProblem } from '../LabelTrackingProblem';
import { formatTrackingDisplay } from '../trackingNormalize';
import { AppOrderStageLine } from './AppOrderStageLine';
import { AppOrderShipVerifySheet } from './AppOrderShipVerifySheet';
import type { ShipmentView } from './AppShipmentCard';

const CHANNEL: Record<string, string> = {
  website: 'Website', ebay: 'eBay', amazon: 'Amazon', tiktok: 'TikTok', depop: 'Depop', mercari: 'Mercari',
};

function shortDate(iso?: string | null) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
}

function statusStamp(iso?: string | null) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles',
  });
}

export type AppShipmentDetailProps = {
  client: SupabaseClient;
  shipment: ShipmentView;
  money: (n: number) => string;
  isAdmin: boolean;
  showTracking?: boolean;
  busy: string;
  error: string;
  locations: Record<string, string[]>;
  locationOptions: LocationChoice[];
  photoMap: Record<string, UnitPhoto[]>;
  photoUrls: Record<string, string>;
  trackingDraft: string;
  onTrackingDraft: (v: string) => void;
  onBack: () => void;
  onSetLocation: (order: WebOrder, code: string) => void;
  onPrintLabel: (download?: boolean) => void;
  onMarkPackaged: () => void;
  onMarkShipped: (barcode: string, overrideReason?: string) => void | Promise<boolean>;
  onMarkDelivered: () => void;
  onStepBack: () => void;
  onSaveTracking: () => void;
  onUploadLabel: () => void;
  onVoidLabel: () => void;
  labelInputRef: RefObject<HTMLInputElement | null>;
  onUrl: (path: string, url: string) => void;
  onLabelFile: (file: File) => void;
  labelHit?: { number: string; carrier?: string | null; layer?: string | null } | null;
  trackingPick?: { number: string; carrier?: string | null; source?: string | null }[] | null;
  onConfirmTrackingPick?: (number: string, carrier?: string | null) => void;
  onDismissLabelHit?: () => void;
  onUseMarketplaceTracking?: () => void;
  onUseLabelTracking?: (number: string, carrier: string) => void;
  onRetryLabelExtract?: () => void;
  onManualTracking?: (number: string, carrier: string) => void;
  onUnbundle?: () => void;
  unbundleBusy?: boolean;
  showUnbundle?: boolean;
};

/** Full shipment page for a manual bundle — same black/white flow as a single order. */
export function AppShipmentDetail(props: AppShipmentDetailProps) {
  const {
    client, shipment, isAdmin, showTracking = false, busy, error,
    locations, locationOptions, photoMap, photoUrls,
    trackingDraft, onTrackingDraft, onBack, onSetLocation,
    onPrintLabel, onMarkPackaged, onMarkShipped, onMarkDelivered, onStepBack,
    onSaveTracking, onUploadLabel, onVoidLabel, labelInputRef,
    onUrl, onLabelFile, labelHit, trackingPick, onConfirmTrackingPick, onDismissLabelHit,
    onUseMarketplaceTracking, onUseLabelTracking, onRetryLabelExtract, onManualTracking,
    onUnbundle, unbundleBusy, showUnbundle,
  } = props;

  const [verifyShip, setVerifyShip] = useState(false);
  const lead = shipment.lead;
  const stage = orderStage(lead);
  const ch = (lead.channel || 'website').toLowerCase();
  const paid = lead.status === 'paid';
  const ship = lead.fulfillment === 'ship';
  const labeled = hasLabel(lead);
  const channelName = CHANNEL[ch] || lead.channel || 'Website';
  const trackNo = showTracking ? (lead.tracking_number || lead.marketplace_tracking_number) : '';
  const trackHref = carrierTrackUrl(trackNo, lead.carrier);
  const pkg = shipment.package;
  const needsEntry = Boolean(lead.tracking_needs_entry && !lead.tracking_number);
  const showProblem = Boolean(
    lead.label_tracking_mismatch || lead.tracking_exception || needsEntry,
  );

  const labelMeta = useMemo(() => {
    if (lead.label_file_name) return lead.label_file_name;
    if (lead.label_storage_path) {
      const seg = lead.label_storage_path.split('/').pop();
      if (seg) return seg;
    }
    return 'Label';
  }, [lead.label_file_name, lead.label_storage_path]);
  const labelDate = shortDate(lead.label_uploaded_at || lead.label_purchased_at);

  const dock = (() => {
    if (!paid || !ship || stage === 'canceled' || stage === 'delivered') return null;
    if (stage === 'verifyWeight' || shipment.items.some((o) => orderNeedsWeightVerify(o))) {
      return null;
    }
    if (orderNeedsLabel(lead) && isAdmin) {
      return { kicker: 'Next step', label: 'Upload label', action: onUploadLabel, primary: 'Upload label' };
    }
    if (stage === 'toShip' && shipment.items.some((o) => orderCanMarkPackaged(o))) {
      return { kicker: 'Next step', label: 'Pack it up', action: onMarkPackaged, primary: busy === 'packaged' ? '…' : 'Mark packaged' };
    }
    if (stage === 'packaged') {
      return { kicker: 'Next step', label: 'Hand to carrier', action: () => setVerifyShip(true), primary: 'Mark shipped' };
    }
    if (stage === 'shipped' && isAdmin) {
      return { kicker: 'Next step', label: 'Confirm delivery', action: onMarkDelivered, primary: busy === 'delivered' ? '…' : 'Mark delivered' };
    }
    return null;
  })();

  async function copyTrack() {
    const text = formatTrackingDisplay(lead.carrier, trackNo);
    if (!text) return;
    try { await navigator.clipboard.writeText(text.replace(/^[^\s]+\s/, '')); } catch { /* ignore */ }
  }

  return (
    <div className="app-stack app-order-detail-stack app-order-detail-v2">
      <div className="app-order-detail-scroll">
        <div className="app-nav app-order-nav">
          <button type="button" onClick={onBack}>‹ Orders</button>
          <div className="app-nav-title">Shipment</div>
          {isAdmin && (orderCanStepBack(lead) || showUnbundle) ? (
            <div className="app-order-nav-menu">
              <ShipmentMenu
                busy={!!busy}
                canStepBack={orderCanStepBack(lead)}
                stage={stage}
                onStepBack={onStepBack}
                showUnbundle={!!showUnbundle}
                onUnbundle={onUnbundle}
                unbundleBusy={unbundleBusy}
                canVoid={lead.label_origin === 'bought' && !lead.delivered_at}
                onVoid={onVoidLabel}
              />
            </div>
          ) : (
            <button type="button" style={{ visibility: 'hidden' }} aria-hidden>·</button>
          )}
        </div>

        <div className="app-order-hero-v2">
          <div className="app-shipment-detail-thumbs" aria-hidden>
            {shipment.items.slice(0, 3).map((order) => {
              const photo = listThumbPhoto(photoMap[order.sku] || []);
              return (
                <UnitListThumb
                  key={order.id}
                  client={client}
                  photoPath={photo?.path || null}
                  urls={photoUrls}
                  onUrl={onUrl}
                  eager
                  className="app-shipment-detail-thumb"
                  placeholder={<span className="app-shipment-detail-thumb empty" />}
                />
              );
            })}
          </div>
          <div className="app-order-hero-v2-copy">
            <h2 className="app-order-hero-v2-title">
              {shipment.itemCount} items · {lead.buyer_name || 'Buyer'}
            </h2>
            <p className="app-order-hero-v2-meta">
              {channelName} · {shortDate(lead.paid_at || lead.created_at)}
              {pkg ? ` · Box ${pkg.length_in}×${pkg.width_in}×${pkg.height_in} in · ${pkg.weight_lb} lb` : ''}
            </p>
          </div>
        </div>

        {ship && stage !== 'canceled' && <AppOrderStageLine stage={stage as OrderStage} />}

        <section className="app-shipment-items">
          <h3 className="app-order-ready-head">Items in this box</h3>
          <ul className="app-shipment-item-list">
            {shipment.items.map((order) => {
              const code = locations[order.sku]?.[0] || '';
              const parts = locationParts(code);
              const photo = listThumbPhoto(photoMap[order.sku] || []);
              return (
                <li key={order.id} className="app-shipment-item-row">
                  <UnitListThumb
                    client={client}
                    photoPath={photo?.path || null}
                    urls={photoUrls}
                    onUrl={onUrl}
                    className="app-shipment-item-thumb"
                    placeholder={<span className="app-shipment-item-thumb no-photo">—</span>}
                  />
                  <div className="app-shipment-item-copy">
                    <p className="app-order-title clamp-2">{displayOrderTitle(order.title || order.marketplace_title)}</p>
                    <p className="app-order-sku-line"><span className="lbl">SKU</span> <strong>{order.sku}</strong></p>
                    {stage === 'toShip' && paid && ship ? (
                      <label className={`app-order-pick-loc-v2${parts ? '' : ' missing'}`}>
                        <strong>{(() => { const hit = locationOptions.find((location) => location.code === code); return hit ? locationMenuLabel(hit) : (parts ? `Bay ${parts.bay} · ${parts.slot}` : 'No location'); })()}</strong>
                        <select
                          aria-label={`Set pick location for SKU ${order.sku}`}
                          value={code}
                          disabled={!!busy || !locationOptions.length}
                          onChange={(e) => onSetLocation(order, e.target.value)}
                        >
                          <option value="">{parts ? 'Change location' : 'Set location'}</option>
                          {locationOptions.map((location) => (
                            <option key={location.code} value={location.code}>{locationMenuLabel(location)}</option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <p className={`app-order-loc${parts ? '' : ' missing'}`}>
                        {parts ? `${parts.display} · ${parts.slot}`.toUpperCase() : 'NO LOCATION'}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {labeled && (
          <section className="app-order-ready">
            <h3 className="app-order-ready-head">Label</h3>
            <div className="app-order-step-body app-order-step-label-block">
              <p className="app-order-label-meta">{channelName} · {labelMeta}{labelDate ? ` · ${labelDate}` : ''}</p>
              {trackNo ? (
                <>
                  <p className="app-order-tracking-full">{formatTrackingDisplay(lead.carrier, trackNo)}</p>
                  <p className="app-order-tracking-links">
                    <button type="button" className="app-order-text-link" onClick={() => void copyTrack()}>Copy</button>
                    {trackHref && (
                      <>
                        {' · '}
                        <a className="app-order-text-link" href={trackHref} target="_blank" rel="noreferrer">Track</a>
                      </>
                    )}
                  </p>
                  <div className="app-order-label-btns">
                    <button type="button" className="app-order-outline-btn" disabled={!!busy} onClick={() => onPrintLabel(false)}>Print label</button>
                    <button type="button" className="app-order-outline-btn" disabled={!!busy} onClick={() => onPrintLabel(true)}>Save PDF</button>
                  </div>
                </>
              ) : needsEntry ? (
                <p className="app-order-problem">Tracking still needed — enter it below.</p>
              ) : null}
            </div>
          </section>
        )}

        {stage === 'packaged' && (
          <div className="app-order-status-card">
            <p className="app-order-status-title">Packaged · {statusStamp(lead.packaged_at)}</p>
            <p className="app-order-status-sub">Tap Mark shipped when you hand it off.</p>
            {trackNo && (
              <>
                <p className="app-order-tracking-full">{formatTrackingDisplay(lead.carrier, trackNo)}</p>
                <p className="app-order-tracking-links">
                  <button type="button" className="app-order-text-link" onClick={() => void copyTrack()}>Copy</button>
                  {trackHref && (
                    <>
                      {' · '}
                      <a className="app-order-text-link" href={trackHref} target="_blank" rel="noreferrer">Track</a>
                    </>
                  )}
                </p>
              </>
            )}
          </div>
        )}

        {(stage === 'shipped' || stage === 'delivered') && (
          <div className="app-order-status-card">
            <p className="app-order-status-title">
              {stage === 'delivered' ? 'Delivered' : 'Shipped'} · {statusStamp(stage === 'delivered' ? lead.delivered_at : lead.shipped_at)}
            </p>
            {trackNo && (
              <>
                <p className="app-order-tracking-full">{formatTrackingDisplay(lead.carrier, trackNo)}</p>
                <p className="app-order-tracking-links">
                  <button type="button" className="app-order-text-link" onClick={() => void copyTrack()}>Copy</button>
                  {trackHref && (
                    <>
                      {' · '}
                      <a className="app-order-text-link" href={trackHref} target="_blank" rel="noreferrer">Track</a>
                    </>
                  )}
                </p>
              </>
            )}
          </div>
        )}

        {isAdmin && showProblem && (
          <LabelTrackingProblem
            order={lead}
            busy={!!busy}
            onUseMarketplace={() => onUseMarketplaceTracking?.()}
            onUseLabel={(n, c) => onUseLabelTracking?.(n, c)}
            onManual={(n, c) => onManualTracking?.(n, c)}
            onRetry={() => onRetryLabelExtract?.()}
            onReplace={onUploadLabel}
          />
        )}
        {isAdmin && labelHit && <LabelTrackingResult hit={labelHit} onDismiss={onDismissLabelHit} />}
        {isAdmin && trackingPick && trackingPick.length > 0 && onConfirmTrackingPick && (
          <LabelTrackingPicker
            candidates={trackingPick}
            busy={!!busy}
            onPick={(n, c) => onConfirmTrackingPick(n, c)}
            onManual={() => onTrackingDraft('')}
          />
        )}
        {isAdmin && needsEntry && !showProblem && (
          <form className="app-order-track-entry" onSubmit={(e) => { e.preventDefault(); void onSaveTracking(); }}>
            <label>
              <span className="eyebrow">Tracking number</span>
              <input value={trackingDraft} onChange={(e) => onTrackingDraft(e.target.value)} placeholder="From the label" autoComplete="off" />
            </label>
            <button type="submit" className="secondary" disabled={!!busy || trackingDraft.trim().length < 8}>
              {busy === 'tracking' ? 'Saving…' : 'Save tracking'}
            </button>
          </form>
        )}

        {error && <p className="app-inline-error">{error}</p>}
      </div>

      {dock && (
        <div className="app-order-dock-v2">
          <div className="app-order-dock-v2-copy">
            <span className="eyebrow">{dock.kicker}</span>
            <strong>{dock.label}</strong>
          </div>
          <button
            type="button"
            className="app-order-dock-v2-btn"
            disabled={!!busy || dock.primary.startsWith('…')}
            onClick={() => dock.action()}
          >
            {dock.primary}
          </button>
        </div>
      )}

      {verifyShip && (
        <AppOrderShipVerifySheet
          order={lead}
          isAdmin={isAdmin}
          busy={busy === 'shipped'}
          error={error}
          onClose={() => setVerifyShip(false)}
          onConfirm={async (barcode, reason) => {
            const ok = await onMarkShipped(barcode, reason);
            if (ok) setVerifyShip(false);
          }}
        />
      )}

      <input
        ref={labelInputRef}
        type="file"
        accept="application/pdf,image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onLabelFile(f);
        }}
      />
    </div>
  );
}

function ShipmentMenu({
  busy, canStepBack, stage, onStepBack, showUnbundle, onUnbundle, unbundleBusy, canVoid, onVoid,
}: {
  busy: boolean;
  canStepBack: boolean;
  stage: string;
  onStepBack: () => void;
  showUnbundle: boolean;
  onUnbundle?: () => void;
  unbundleBusy?: boolean;
  canVoid: boolean;
  onVoid: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <button type="button" aria-label="Shipment actions" onClick={() => setMenuOpen((o) => !o)}>···</button>
      {menuOpen && (
        <div className="app-order-nav-pop">
          {canStepBack && (
            <button type="button" disabled={busy} onClick={() => { setMenuOpen(false); onStepBack(); }}>
              {stage === 'shipped' ? 'Move back to Packaged' : 'Step back one step'}
            </button>
          )}
          {showUnbundle && onUnbundle && (
            <button type="button" disabled={busy || unbundleBusy} onClick={() => { setMenuOpen(false); onUnbundle(); }}>
              Unbundle
            </button>
          )}
          {canVoid && (
            <button type="button" disabled={busy} onClick={() => { setMenuOpen(false); onVoid(); }}>Void label</button>
          )}
        </div>
      )}
    </>
  );
}
