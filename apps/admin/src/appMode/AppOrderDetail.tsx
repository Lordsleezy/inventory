import { useEffect, useMemo, useState, type RefObject } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LabelDialog } from '../LabelDialog';
import { displayOrderTitle } from '../orderDisplay';
import { locationParts } from '../locationOrder';
import { locationMenuLabel, type LocationChoice } from '../locationPlace';
import {
  canBuyLabel, hasLabel, onFileWeightLb, orderCanMarkPackaged, orderCanStepBack, orderNeedsLabel,
  orderStage, weightChanged, carrierTrackUrl, type OrderStage,
} from '../orderStage';
import { listThumbPhoto, type UnitPhoto } from '../unitPhotos';
import type { WebOrder } from '../OrdersPage';
import { UnitListThumb } from '../UnitListThumb';
import { LabelTrackingPicker, LabelTrackingResult } from '../LabelTrackingResult';
import { LabelTrackingProblem } from '../LabelTrackingProblem';
import { formatTrackingDisplay } from '../trackingNormalize';
import { AppOrderStageLine } from './AppOrderStageLine';
import { AppOrderShipVerifySheet } from './AppOrderShipVerifySheet';

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

type Sign = (paths: string[]) => Promise<Record<string, string>>;

export type AppOrderDetailProps = {
  client: SupabaseClient;
  storeId: string;
  accessToken: string;
  order: WebOrder;
  money: (n: number) => string;
  stamp: (s: string) => string;
  isAdmin: boolean;
  showTracking?: boolean;
  busy: string;
  error: string;
  locationCode: string;
  locationOptions: LocationChoice[];
  photos: UnitPhoto[];
  photoUrls: Record<string, string>;
  sign: Sign;
  events: { status?: string; status_detail?: string | null; location?: string | null; occurred_at?: string | null }[];
  trackingDraft: string;
  onTrackingDraft: (v: string) => void;
  onBack: () => void;
  onSetLocation: (code: string) => void;
  onPrintLabel: (download?: boolean) => void;
  onMarkPackaged: () => void;
  onVerifyWeight: (weightLb: number, confirmed?: boolean) => void;
  onMarkShipped: (barcode: string, overrideReason?: string) => void | Promise<boolean>;
  onMarkDelivered: () => void;
  onStepBack: () => void;
  onFloorCancel: () => void;
  onSaveTracking: () => void;
  onUploadLabel: () => void;
  onUploadPackProof: () => void;
  onVoidLabel: () => void;
  onRecordLabelCost?: () => void;
  labelInputRef: RefObject<HTMLInputElement | null>;
  packProofInputRef: RefObject<HTMLInputElement | null>;
  onLabelOpen: () => void;
  labelOpen: boolean;
  onLabelClose: () => void;
  onReload: () => void;
  onUrl: (path: string, url: string) => void;
  onLabelFile: (file: File) => void;
  onPackProofFile: (file: File) => void;
  labelHit?: { number: string; carrier?: string | null; layer?: string | null } | null;
  trackingPick?: { number: string; carrier?: string | null; source?: string | null }[] | null;
  onConfirmTrackingPick?: (number: string, carrier?: string | null) => void;
  onDismissLabelHit?: () => void;
  onUseMarketplaceTracking?: () => void;
  onUseLabelTracking?: (number: string, carrier: string) => void;
  onRetryLabelExtract?: () => void;
  onManualTracking?: (number: string, carrier: string) => void;
};

export function AppOrderDetail(props: AppOrderDetailProps) {
  const {
    client, accessToken, order, isAdmin, showTracking = false, busy, error,
    locationCode, locationOptions, photos, photoUrls,
    trackingDraft, onTrackingDraft, onBack, onSetLocation,
    onPrintLabel, onMarkPackaged, onVerifyWeight, onMarkShipped, onMarkDelivered,
    onStepBack, onFloorCancel, onSaveTracking, onUploadLabel,
    onVoidLabel, onRecordLabelCost,
    labelInputRef, packProofInputRef, onLabelOpen, labelOpen, onLabelClose, onReload,
    onUrl, onLabelFile, onPackProofFile, labelHit, trackingPick, onConfirmTrackingPick, onDismissLabelHit,
    onUseMarketplaceTracking, onUseLabelTracking, onRetryLabelExtract, onManualTracking,
  } = props;

  const [photosOpen, setPhotosOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [verifyShip, setVerifyShip] = useState(false);
  const onFileLb = onFileWeightLb(order);
  const [weightDraft, setWeightDraft] = useState(() => (onFileLb != null ? String(onFileLb) : ''));
  useEffect(() => {
    setWeightDraft(onFileLb != null ? String(onFileLb) : '');
  }, [order.id, onFileLb]);
  const stage = orderStage(order);
  const ch = (order.channel || 'website').toLowerCase();
  const paid = order.status === 'paid';
  const ship = order.fulfillment === 'ship';
  const buy = canBuyLabel(ch);
  const labeled = hasLabel(order);
  const parts = locationParts(locationCode);
  const thumbPhoto = listThumbPhoto(photos);
  const heroPath = thumbPhoto?.path || null;
  const channelName = CHANNEL[ch] || order.channel || 'Website';
  const metaLine = `SKU ${order.sku || '—'} · ${channelName} · ${shortDate(order.paid_at || order.created_at)}`;
  const trackNo = showTracking ? (order.tracking_number || order.marketplace_tracking_number) : '';
  const trackHref = carrierTrackUrl(trackNo, order.carrier);
  const changed = weightChanged(order);

  const labelMeta = useMemo(() => {
    if (order.label_file_name) return order.label_file_name;
    if (order.label_storage_path) {
      const seg = order.label_storage_path.split('/').pop();
      if (seg) return seg;
    }
    return 'Label';
  }, [order.label_file_name, order.label_storage_path]);

  const labelDate = shortDate(order.label_uploaded_at || order.label_purchased_at);

  if (labelOpen && buy && ship && paid) {
    return (
      <LabelDialog
        order={order}
        accessToken={accessToken}
        money={props.money}
        appMode
        onClose={() => { onLabelClose(); void onReload(); }}
        onPurchased={() => { void onReload(); }}
        onDone={() => { onLabelClose(); void onReload(); }}
      />
    );
  }

  const dock = (() => {
    if (!paid || !ship || stage === 'canceled' || stage === 'delivered') return null;
    if (stage === 'verifyWeight') {
      return {
        kicker: 'Next step',
        label: 'Confirm unpacked weight',
        action: () => {
          const lb = Number(String(weightDraft || '').trim());
          if (!Number.isFinite(lb) || lb <= 0 || lb >= 200) return;
          onVerifyWeight(lb, false);
        },
        primary: busy === 'weight' ? '…' : 'Save weight',
      };
    }
    if (orderNeedsLabel(order) && isAdmin) {
      return { kicker: 'Next step', label: 'Upload label', action: onUploadLabel, primary: 'Upload label' };
    }
    if (stage === 'toShip' && orderCanMarkPackaged(order)) {
      return { kicker: 'Next step', label: 'Pack it up', action: onMarkPackaged, primary: busy === 'packaged' ? '…' : 'Mark packaged' };
    }
    if (stage === 'packaged') {
      return { kicker: 'Next step', label: 'Hand to carrier', action: () => setVerifyShip(true), primary: 'Mark shipped' };
    }
    if (stage === 'shipped' && isAdmin) {
      return { kicker: 'Next step', label: 'Confirm delivery', action: onMarkDelivered, primary: busy === 'delivered' ? '…' : 'Mark delivered' };
    }
    if (!labeled && buy && !orderNeedsLabel(order) && isAdmin) {
      return { kicker: 'Next step', label: 'Buy postage', action: onLabelOpen, primary: 'Buy label' };
    }
    return null;
  })();

  async function copyTrack() {
    const text = formatTrackingDisplay(order.carrier, trackNo);
    if (!text) return;
    try { await navigator.clipboard.writeText(text.replace(/^[^\s]+\s/, '')); } catch { /* ignore */ }
  }

  return (
    <div className="app-stack app-order-detail-stack app-order-detail-v2">
      <div className="app-order-detail-scroll">
        <div className="app-nav app-order-nav">
          <button type="button" onClick={onBack}>‹ Orders</button>
          <div className="app-nav-title">Order</div>
          {isAdmin && (orderCanStepBack(order) || onRecordLabelCost) ? (
            <div className="app-order-nav-menu">
              <button type="button" aria-label="Order actions" onClick={() => setMenuOpen((o) => !o)}>···</button>
              {menuOpen && (
                <div className="app-order-nav-pop">
                  {orderCanStepBack(order) && (
                    <button type="button" disabled={!!busy} onClick={() => { setMenuOpen(false); onStepBack(); }}>
                      {stage === 'shipped' ? 'Move back to Packaged' : 'Step back one step'}
                    </button>
                  )}
                  {onRecordLabelCost && (
                    <button type="button" disabled={!!busy} onClick={() => { setMenuOpen(false); onRecordLabelCost(); }}>
                      {order.label_cost_cents != null ? 'Edit label cost' : 'Record label cost'}
                    </button>
                  )}
                  {order.label_origin === 'bought' && !order.delivered_at && (
                    <button type="button" disabled={!!busy} onClick={() => { setMenuOpen(false); onVoidLabel(); }}>Void label</button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <button type="button" style={{ visibility: 'hidden' }} aria-hidden>·</button>
          )}
        </div>

        <div className="app-order-hero-v2">
          <button type="button" className="app-order-hero-v2-photo" onClick={() => photos.length && setPhotosOpen(true)} aria-label={photos.length ? `View ${photos.length} photos` : 'No photos'}>
            <UnitListThumb
              client={client}
              photoPath={heroPath}
              urls={photoUrls}
              onUrl={onUrl}
              eager
              className="app-order-hero-v2-thumb"
              placeholder={<span className="app-order-hero-v2-thumb empty" />}
            />
          </button>
          <div className="app-order-hero-v2-copy">
            <h2 className="app-order-hero-v2-title">{displayOrderTitle(order.title || order.marketplace_title)}</h2>
            <p className="app-order-hero-v2-meta">{metaLine}</p>
          </div>
        </div>

        {ship && stage !== 'canceled' && stage !== 'verifyWeight' && stage !== 'needsLabel' && (
          <AppOrderStageLine stage={stage as OrderStage} />
        )}

        {stage === 'verifyWeight' && paid && ship && (
          <section className="app-order-ready">
            <h3 className="app-order-ready-head">Verify weight</h3>
            <p className="app-order-status-sub" style={{ margin: '0 0 12px' }}>
              Weigh the unpacked item. Saving updates the unit so remaining qty stays correct.
            </p>
            <label className="app-order-weight-field">
              <span className="app-order-step-label">Item weight (lb)</span>
              <input
                type="number"
                inputMode="decimal"
                min={0.01}
                max={199.99}
                step={0.01}
                value={weightDraft}
                disabled={!!busy}
                onChange={(e) => setWeightDraft(e.target.value)}
              />
            </label>
            {onFileLb != null && (
              <p className="app-order-status-sub" style={{ marginTop: 10 }}>
                On file: {onFileLb} lb
                {' · '}
                <button
                  type="button"
                  className="app-order-text-link"
                  disabled={!!busy}
                  onClick={() => {
                    setWeightDraft(String(onFileLb));
                    onVerifyWeight(onFileLb, true);
                  }}
                >
                  Confirm on file
                </button>
              </p>
            )}
          </section>
        )}

        {(stage === 'needsLabel' || stage === 'toShip') && order.weight_verified_lb != null && (
          <div className="app-order-status-card">
            <p className="app-order-status-title">Weight {order.weight_verified_lb} lb</p>
            {changed && order.weight_on_file_lb != null && (
              <p className="app-order-status-sub">
                Was <span className="app-order-weight-old">{order.weight_on_file_lb} lb</span>
              </p>
            )}
          </div>
        )}

        {stage === 'toShip' && paid && ship && (
          <section className="app-order-ready">
            <h3 className="app-order-ready-head">Get it ready</h3>
            <ol className="app-order-ready-steps">
              <li>
                <span className="app-order-step-num">1</span>
                <div className="app-order-step-body">
                  <span className="app-order-step-label">Pick from</span>
                  <label className={`app-order-pick-loc-v2${parts ? '' : ' missing'}`}>
                    <strong>{(() => { const hit = locationOptions.find((location) => location.code === locationCode); return hit ? locationMenuLabel(hit) : (parts ? `Bay ${parts.bay} · ${parts.slot}` : 'No location'); })()}</strong>
                    <select
                      aria-label={`Set pick location for SKU ${order.sku}`}
                      value={locationCode}
                      disabled={!!busy || !locationOptions.length}
                      onChange={(e) => onSetLocation(e.target.value)}
                    >
                      <option value="">{parts ? 'Change location' : 'Set location'}</option>
                      {locationOptions.map((location) => (
                        <option key={location.code} value={location.code}>{locationMenuLabel(location)}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {photos.length > 0 && (
                  <button type="button" className="app-order-photos-pill" onClick={() => setPhotosOpen(true)}>
                    {photos.length} photos ›
                  </button>
                )}
              </li>
              {labeled && (
                <li>
                  <span className="app-order-step-num">2</span>
                  <div className="app-order-step-body app-order-step-label-block">
                    <span className="app-order-step-label">Label</span>
                    <p className="app-order-label-meta">{channelName} · {labelMeta}{labelDate ? ` · ${labelDate}` : ''}</p>
                    {trackNo && (
                      <>
                        <p className="app-order-tracking-full">{formatTrackingDisplay(order.carrier, trackNo)}</p>
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
                    )}
                  </div>
                </li>
              )}
            </ol>
          </section>
        )}

        {stage === 'packaged' && (
          <>
            <div className="app-order-status-card">
              <p className="app-order-status-title">Packaged · {statusStamp(order.packaged_at)}</p>
              <p className="app-order-status-sub">Tap Mark shipped when you hand it off. Tracking then updates on its own.</p>
              {trackNo && (
                <>
                  <p className="app-order-tracking-full">{formatTrackingDisplay(order.carrier, trackNo)}</p>
                  <p className="app-order-tracking-links">
                    <button type="button" className="app-order-text-link" onClick={() => void copyTrack()}>Copy</button>
                    {trackHref && (
                      <>
                        {' · '}
                        <a className="app-order-text-link" href={trackHref} target="_blank" rel="noreferrer">Track</a>
                      </>
                    )}
                    {labeled && (
                      <>
                        {' · '}
                        <button type="button" className="app-order-text-link" disabled={!!busy} onClick={() => onPrintLabel(false)}>Reprint label</button>
                      </>
                    )}
                  </p>
                </>
              )}
            </div>
            {order.packaged_at && !order.shipped_at && (
              <button type="button" className="app-order-text-back" disabled={!!busy} onClick={onStepBack}>
                Move back to To ship
              </button>
            )}
          </>
        )}

        {(stage === 'shipped' || stage === 'delivered') && (
          <div className="app-order-status-card">
            <p className="app-order-status-title">
              {stage === 'delivered' ? 'Delivered' : 'Shipped'} · {statusStamp(stage === 'delivered' ? order.delivered_at : order.shipped_at)}
            </p>
            {trackNo && (
              <>
                <p className="app-order-tracking-full">{formatTrackingDisplay(order.carrier, trackNo)}</p>
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

        {isAdmin && (order.label_tracking_mismatch || order.tracking_exception || (order.tracking_needs_entry && !order.tracking_number)) && (
          <LabelTrackingProblem
            order={order}
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
        {isAdmin && order.tracking_needs_entry && !order.tracking_number && !(order.label_tracking_mismatch || order.tracking_exception) && !onManualTracking && (
          <form className="app-order-track-entry" onSubmit={(e) => { e.preventDefault(); void onSaveTracking(); }}>
            <label>
              <span className="eyebrow">Tracking number</span>
              <input value={trackingDraft} onChange={(e) => onTrackingDraft(e.target.value)} placeholder="From the label" autoComplete="off" />
            </label>
            <button type="submit" className="secondary" disabled={!!busy || trackingDraft.trim().length < 8}>{busy === 'tracking' ? 'Saving…' : 'Save tracking'}</button>
          </form>
        )}

        {error && <p className="app-inline-error">{error}</p>}

        {isAdmin && !order.delivered_at && !order.picked_up_at && paid && (
          <button type="button" className="app-order-cancel" disabled={!!busy} onClick={onFloorCancel}>Cancel order</button>
        )}
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
            onClick={() => {
              if (dock.primary === 'Buy label') onLabelOpen();
              else dock.action();
            }}
          >
            {dock.primary}
          </button>
        </div>
      )}

      {verifyShip && (
        <AppOrderShipVerifySheet
          order={order}
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

      {photosOpen && (
        <div className="app-order-photo-sheet" role="dialog" aria-modal="true">
          <div className="app-order-photo-sheet-bar">
            <button type="button" onClick={() => setPhotosOpen(false)}>Done</button>
          </div>
          <div className="app-order-photo-grid">
            {photos.map((p) => (
              <UnitListThumb key={p.id} client={client} photoPath={p.path} urls={photoUrls} onUrl={onUrl} className="app-order-photo-grid-thumb" />
            ))}
          </div>
        </div>
      )}

      <input ref={labelInputRef} className="sr-only" type="file" accept="application/pdf,image/*" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onLabelFile(f); }} />
      <input ref={packProofInputRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPackProofFile(f); }} />
    </div>
  );
}
