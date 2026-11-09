import { useMemo, useRef, useState, type RefObject } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LabelDialog } from '../LabelDialog';
import { OrderStageTabs, OrderTimelineList } from '../OrderFulfillment';
import { OrderFacts, OrderPhotoCarousel } from '../OrderPhotos';
import { displayOrderTitle } from '../orderDisplay';
import { locationParts } from '../locationOrder';
import { canBuyLabel, hasLabel, orderCanStepBack, orderNeedsLabel, orderStage, orderTimeline, type OrderStage } from '../orderStage';
import { listThumbPhoto, photoKind, type UnitPhoto } from '../unitPhotos';
import type { WebOrder } from '../OrdersPage';
import { PackLabelScan } from '../PackLabelScan';
import { UnitListThumb } from '../UnitListThumb';
import { LabelTrackingPicker, LabelTrackingResult } from '../LabelTrackingResult';
import { LabelTrackingProblem } from '../LabelTrackingProblem';

const CHANNEL: Record<string, string> = {
  website: 'Website', ebay: 'eBay', amazon: 'Amazon', tiktok: 'TikTok', depop: 'Depop', mercari: 'Mercari',
};

function when(iso?: string | null) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
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
  busy: string;
  error: string;
  locationCode: string;
  locationOptions: { code: string }[];
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
  onMarkShipped: () => void;
  onMarkDelivered: () => void;
  onStepBack: () => void;
  onFloorCancel: () => void;
  onSaveTracking: () => void;
  onUploadLabel: () => void;
  onUploadPackProof: () => void;
  onVoidLabel: () => void;
  onPackCondition?: (status: 'ok' | 'not_as_listed') => void;
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
    client, accessToken, order, money, stamp, isAdmin, busy, error,
    locationCode, locationOptions, photos, photoUrls, sign, events,
    trackingDraft, onTrackingDraft, onBack, onSetLocation,
    onPrintLabel, onMarkPackaged, onMarkShipped, onMarkDelivered,
    onStepBack, onFloorCancel, onSaveTracking, onUploadLabel, onUploadPackProof,
    onVoidLabel, onPackCondition, onRecordLabelCost,
    labelInputRef, packProofInputRef, onLabelOpen, labelOpen, onLabelClose, onReload,
    onUrl, onLabelFile, onPackProofFile, labelHit, trackingPick, onConfirmTrackingPick, onDismissLabelHit,
    onUseMarketplaceTracking, onUseLabelTracking, onRetryLabelExtract, onManualTracking,
  } = props;

  const [photosOpen, setPhotosOpen] = useState(false);
  const stage = orderStage(order);
  const ch = (order.channel || 'website').toLowerCase();
  const paid = order.status === 'paid';
  const ship = order.fulfillment === 'ship';
  const buy = canBuyLabel(ch);
  const labeled = hasLabel(order);
  const timeline = orderTimeline(order, events);
  const parts = locationParts(locationCode);
  const thumbPhoto = listThumbPhoto(photos);
  const heroPath = thumbPhoto?.path || null;
  const stockTag = thumbPhoto && photoKind(thumbPhoto) === 'Stock photo';

  const labelText = order.label_origin === 'upload'
    ? `Uploaded · ${CHANNEL[ch] || order.channel || 'Label'}`
  : order.label_origin === 'bought' || order.label_purchased_at
    ? `Bought${isAdmin && order.label_cost_cents != null ? ` · ${money(order.label_cost_cents)}` : ''}`
    : orderNeedsLabel(order) ? 'Upload label' : buy ? 'Buy label' : '—';

  const shipTo = useMemo(() => (
    [order.buyer_name, order.ship_line1, order.ship_line2, [order.ship_city, order.ship_region, order.ship_postal].filter(Boolean).join(', ')]
      .filter(Boolean).join(' · ')
  ), [order]);

  if (labelOpen && buy && ship && paid) {
    return (
      <LabelDialog
        order={order}
        accessToken={accessToken}
        money={money}
        appMode
        onClose={() => { onLabelClose(); void onReload(); }}
        onPurchased={() => { void onReload(); }}
        onDone={() => { onLabelClose(); void onReload(); }}
      />
    );
  }

  const primary = (() => {
    if (!paid || !ship || stage === 'canceled') return null;
    if (orderNeedsLabel(order)) return { label: busy === 'upload-label' ? '…' : order.label_storage_path ? 'Replace label' : 'Upload label', fn: onUploadLabel };
    if (stage === 'toShip') return { label: busy === 'packaged' ? '…' : 'Packaged', fn: onMarkPackaged };
    if (stage === 'packaged') return { label: busy === 'shipped' ? '…' : 'Mark shipped', fn: onMarkShipped };
    if (stage === 'shipped' && isAdmin) return { label: busy === 'delivered' ? '…' : 'Mark delivered', fn: onMarkDelivered };
    if (!labeled && buy && !orderNeedsLabel(order)) return { label: 'Buy label', fn: onLabelOpen };
    return null;
  })();

  return (
    <div className="app-stack app-order-detail-stack">
      <div className="app-order-detail-scroll">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ Orders</button>
        <div className="app-nav-title">Order</div>
        <button type="button" style={{ visibility: 'hidden' }} aria-hidden>·</button>
      </div>

      <div className="app-order-hero">
        <button type="button" className="app-order-hero-photo" onClick={() => photos.length && setPhotosOpen(true)} aria-label={photos.length ? `View ${photos.length} photos` : 'No photos'}>
          <UnitListThumb
            client={client}
            photoPath={heroPath}
            urls={photoUrls}
            onUrl={onUrl}
            eager
            className="app-order-hero-thumb"
            placeholder={<span className="app-order-hero-thumb empty">No photo</span>}
          />
          {stockTag && <span className="app-order-hero-tag">Stock photo</span>}
        </button>
        <div className="app-order-hero-copy">
          <h2 className="app-order-hero-title">{displayOrderTitle(order.title || order.marketplace_title)}</h2>
          <p className="app-order-hero-sku"><span className="lbl">SKU</span> <strong>{order.sku || '—'}</strong></p>
          <p className="app-order-hero-meta">{isAdmin ? `${CHANNEL[ch] || order.channel} · ${money(order.item_cents || 0)} · ` : ''}{when(order.paid_at || order.created_at)}</p>
        </div>
      </div>

      <section className="app-order-pick">
        <div className="app-order-pick-head">
          <span className="eyebrow">Pick from</span>
          {photos.length > 0 && (
            <button type="button" className="app-order-photos-link" onClick={() => setPhotosOpen(true)}>
              {photos.length} photo{photos.length === 1 ? '' : 's'} ›
            </button>
          )}
        </div>
        <label className={`app-order-pick-loc${parts ? '' : ' missing'}`}>
          <strong>{parts ? `Bay ${parts.bay} · ${parts.slot}` : 'No location'}</strong>
          <select
            aria-label={`Set pick location for SKU ${order.sku}`}
            value={locationCode}
            disabled={!!busy || !locationOptions.length}
            onChange={(e) => onSetLocation(e.target.value)}
          >
            <option value="">{parts ? 'Change location' : 'Set location'}</option>
            {locationOptions.map((location) => {
              const bit = locationParts(location.code);
              return <option key={location.code} value={location.code}>{bit ? `Bay ${bit.bay} · ${bit.slot}` : location.code}</option>;
            })}
          </select>
        </label>
      </section>

      {!isAdmin && shipTo && <p className="app-order-plain"><span className="eyebrow">Ship to</span> {shipTo}</p>}
      {ship && stage !== 'canceled' && <OrderStageTabs stage={stage as OrderStage} />}
      <OrderFacts layout="app" label={labelText} labeled={labeled} order={order} />

      {order.scanned_out_at && (
        <p className="app-order-plain">Scanned out {stamp(order.scanned_out_at)}{order.scanned_out_by_name ? ` by ${order.scanned_out_by_name}` : ''}</p>
      )}
      {(order.label_tracking_mismatch || order.tracking_exception || (order.tracking_needs_entry && !order.tracking_number)) && (
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
      {labelHit && <LabelTrackingResult hit={labelHit} onDismiss={onDismissLabelHit} />}
      {trackingPick && trackingPick.length > 0 && onConfirmTrackingPick && (
        <LabelTrackingPicker
          candidates={trackingPick}
          busy={!!busy}
          onPick={(n, c) => onConfirmTrackingPick(n, c)}
          onManual={() => onTrackingDraft('')}
        />
      )}
      {order.tracking_needs_entry && !order.tracking_number && (
        <form className="app-order-track-entry" onSubmit={(e) => { e.preventDefault(); void onSaveTracking(); }}>
          <label>
            <span className="eyebrow">Tracking number</span>
            <input value={trackingDraft} onChange={(e) => onTrackingDraft(e.target.value)} placeholder="From the label" autoComplete="off" />
          </label>
          <button type="submit" className="secondary" disabled={!!busy || trackingDraft.trim().length < 8}>{busy === 'tracking' ? 'Saving…' : 'Save tracking'}</button>
        </form>
      )}
      {error && <p className="app-inline-error">{error}</p>}

      {paid && ship && stage !== 'canceled' && (
        <div className="app-order-work">
          {stage === 'toShip' && labeled && <PackLabelScan client={client} disabled={!!busy} onDone={onReload} />}
          {(labeled || orderNeedsLabel(order)) && (
            <div className="app-order-label-actions">
              {labeled && (
                <>
                  <button type="button" className="secondary" disabled={!!busy} onClick={() => onPrintLabel(false)}>{busy === 'print' ? '…' : 'Print label'}</button>
                  <button type="button" className="secondary" disabled={!!busy} onClick={() => onPrintLabel(true)}>Save PDF</button>
                </>
              )}
            </div>
          )}
          {stage === 'toShip' && labeled && !orderNeedsLabel(order) && (
            <button type="button" className="primary app-order-packaged-btn" disabled={!!busy} onClick={onMarkPackaged}>
              {busy === 'packaged' ? '…' : 'Packaged'}
            </button>
          )}
        </div>
      )}

      {timeline.length > 0 && (
        <div className="app-order-log">
          <OrderTimelineList rows={timeline} stamp={stamp} />
        </div>
      )}

      {paid && ship && stage !== 'canceled' && (
        <details className="app-order-extra">
          <summary>More on this order</summary>
          {shipTo && <p className="app-order-plain"><span className="eyebrow">Ship to</span> {shipTo}</p>}
          {onPackCondition && stage === 'toShip' && (
            <div className="app-order-extra-actions">
              <button type="button" className="secondary" disabled={!!busy} onClick={() => onPackCondition('ok')}>Item matches listing</button>
              <button type="button" className="secondary" disabled={!!busy} onClick={() => onPackCondition('not_as_listed')}>Not as listed</button>
            </div>
          )}
          {order.pack_condition === 'not_as_listed' && <p className="app-inline-error">Not as listed — do not buy a label.</p>}
          {onRecordLabelCost && (ch !== 'depop') && (
            <button type="button" className="secondary" disabled={!!busy || order.pack_condition !== 'ok'} onClick={onRecordLabelCost}>
              {order.label_cost_cents != null ? 'Edit label cost' : 'Record label cost'}
            </button>
          )}
          {order.label_origin === 'bought' && !order.delivered_at && (
            <button type="button" className="secondary" disabled={!!busy} onClick={onVoidLabel}>{busy === 'void' ? '…' : 'Void label'}</button>
          )}
          {(ch === 'amazon' || ch === 'tiktok') && !order.delivered_at && (
            <button type="button" className="secondary" disabled={!!busy} onClick={onUploadPackProof}>
              {order.pack_proof_photo_path ? 'Replace pack photo' : 'Add pack photo'}
            </button>
          )}
        </details>
      )}

      {isAdmin && orderCanStepBack(order) && paid && ship && stage !== 'canceled' && (
        <div className="app-order-extra-actions">
          <button type="button" className="secondary" disabled={!!busy} onClick={onStepBack}>
            {busy === 'step-back' ? '…' : 'Step back one fulfillment step'}
          </button>
        </div>
      )}

      {!order.delivered_at && !order.picked_up_at && paid && (
        <button type="button" className="app-order-cancel" disabled={!!busy} onClick={onFloorCancel}>Cancel in Floor</button>
      )}
      </div>

      {primary && (
        <div className="app-order-dock">
          <button
            type="button"
            className="primary"
            disabled={!!busy || (primary.label === 'Buy label' && order.pack_condition === 'not_as_listed')}
            onClick={() => {
              if (primary.label === 'Buy label') onLabelOpen();
              else if (primary.label.startsWith('Upload') || primary.label === 'Replace label') onUploadLabel();
              else primary.fn();
            }}
          >
            {primary.label}
          </button>
        </div>
      )}

      {photosOpen && (
        <div className="app-order-photo-sheet" role="dialog" aria-modal="true">
          <div className="app-order-photo-sheet-bar">
            <button type="button" onClick={() => setPhotosOpen(false)}>Done</button>
          </div>
          <OrderPhotoCarousel photos={photos} urls={photoUrls} sign={sign} />
        </div>
      )}

      <input ref={labelInputRef} className="sr-only" type="file" accept="application/pdf,image/*" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onLabelFile(f); }} />
      <input ref={packProofInputRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPackProofFile(f); }} />
    </div>
  );
}
