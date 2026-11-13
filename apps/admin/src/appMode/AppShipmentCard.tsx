import type { SupabaseClient } from '@supabase/supabase-js';
import type { WebOrder } from '../OrdersPage';
import { displayOrderTitle } from '../orderDisplay';
import { locationParts } from '../locationOrder';
import { hasLabel, orderNeedsLabel, orderNeedsWeightVerify } from '../orderStage';
import { UnitListThumb } from '../UnitListThumb';
import { listThumbPhoto } from '../unitPhotos';
import type { UnitPhoto } from '../unitPhotos';

export type ShipmentView = {
  id: string;
  bundled: boolean;
  itemCount: number;
  items: WebOrder[];
  lead: WebOrder;
  package?: { length_in?: number; width_in?: number; height_in?: number; weight_lb?: number } | null;
};

type Props = {
  shipment: ShipmentView;
  client: SupabaseClient;
  photoMap: Record<string, UnitPhoto[]>;
  photoUrls: Record<string, string>;
  locations: Record<string, string[]>;
  money: (n: number) => string;
  channelName: string;
  trackingTail: string;
  onOpen: (order: WebOrder) => void;
  /** Open the full shipment detail page (preferred over expand-only). */
  onOpenShipment?: () => void;
  onUrl: (path: string, url: string) => void;
  showUpload?: boolean;
  onUpload?: (file: File) => void;
  showAddWeight?: boolean;
  onAddWeight?: () => void;
  onPrint?: () => void;
  showPackaged?: boolean;
  onPackaged?: () => void;
  packagedBusy?: boolean;
  showMarkShipped?: boolean;
  onMarkShipped?: () => void;
  showUnbundle?: boolean;
  onUnbundle?: () => void;
  unbundleBusy?: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  hideMoney?: boolean;
};

/** Compact card for a manually bundled shipment only. No checkboxes. */
export function AppShipmentCard({
  shipment, client, photoMap, photoUrls, locations, money, channelName, trackingTail,
  onOpen, onOpenShipment, onUrl, showUpload, onUpload, showAddWeight, onAddWeight,
  onPrint, showPackaged, onPackaged, packagedBusy,
  showMarkShipped, onMarkShipped, showUnbundle, onUnbundle, unbundleBusy,
  expanded, onToggleExpand, hideMoney = false,
}: Props) {
  const lead = shipment.lead;
  const needsLabel = orderNeedsLabel(lead);
  const needsWeight = orderNeedsWeightVerify(lead);
  const loc = locationParts(locations[lead.sku]?.[0]);
  const titles = shipment.items
    .map((order) => displayOrderTitle(order.title || order.marketplace_title))
    .filter(Boolean);
  const summary = titles.slice(0, 2).join(' · ');
  const meta = hideMoney
    ? [trackingTail].filter(Boolean).join(' · ')
    : needsLabel || needsWeight
      ? `${channelName} · ${shipment.itemCount} items`
      : [channelName, `${shipment.itemCount} items`, trackingTail].filter(Boolean).join(' · ');
  const locLine = loc ? `${loc.display} · ${loc.slot}`.toUpperCase() : '';
  const pkg = shipment.package;
  const showActions = Boolean(
    (hasLabel(lead) && onPrint)
    || (showAddWeight && onAddWeight)
    || (showUpload && onUpload)
    || (showPackaged && onPackaged)
    || (showMarkShipped && onMarkShipped)
    || (showUnbundle && onUnbundle),
  );

  return (
    <div className={`app-row app-shipment-card compact${needsLabel || needsWeight ? ' needs-label' : ''}`}>
      <button
        type="button"
        className="app-order-open-v2"
        onClick={() => {
          if (onOpenShipment) onOpenShipment();
          else onToggleExpand();
        }}
      >
        <span className="app-shipment-thumbs compact">
          {shipment.items.slice(0, 3).map((order) => {
            const photo = listThumbPhoto(photoMap[order.sku] || []);
            return (
              <UnitListThumb
                key={order.id}
                client={client}
                photoPath={photo?.path || null}
                urls={photoUrls}
                onUrl={onUrl}
                className="app-shipment-thumb"
                placeholder={<span className="app-shipment-thumb no-photo">—</span>}
              />
            );
          })}
        </span>
        <span className="app-order-copy">
          <span className="app-order-title">{shipment.itemCount} items · {lead.buyer_name || 'Buyer'}</span>
          <span className="app-order-sku-line clamp-2">{summary}{titles.length > 2 ? '…' : ''}</span>
          <span className="app-order-meta">{meta}</span>
          {pkg && (
            <span className="app-order-meta">
              Box {pkg.length_in}×{pkg.width_in}×{pkg.height_in} in · {pkg.weight_lb} lb
            </span>
          )}
          {shipment.itemCount < 2 && (
            <span className={`app-order-loc${loc ? '' : ' missing'}`}>{locLine || 'NO LOCATION'}</span>
          )}
          {needsWeight && <span className="app-order-problem">Verify weight</span>}
          {!needsWeight && needsLabel && <span className="app-order-problem">Needs label</span>}
          {lead.tracking_needs_entry && !lead.tracking_number && (
            <span className="app-order-problem">Tracking needed — open to enter</span>
          )}
        </span>
      </button>
      <div className="app-shipment-lines compact" data-open={expanded ? 'true' : 'true'}>
          {shipment.items.map((order) => {
            const lineLoc = locationParts(locations[order.sku]?.[0]);
            const photo = listThumbPhoto(photoMap[order.sku] || []);
            return (
              <button
                key={order.id}
                type="button"
                className="app-shipment-line"
                onClick={() => onOpen(order)}
              >
                <UnitListThumb
                  client={client}
                  photoPath={photo?.path || null}
                  urls={photoUrls}
                  onUrl={onUrl}
                  className="app-shipment-line-thumb"
                  placeholder={<span className="app-shipment-line-thumb no-photo">—</span>}
                />
                <span className="app-shipment-line-copy">
                  <span className="app-order-title clamp-2">{displayOrderTitle(order.title || order.marketplace_title)}</span>
                  <span className="app-order-sku-line"><span className="lbl">SKU</span> <strong>{order.sku}</strong></span>
                  <span className={`app-order-loc${lineLoc ? '' : ' missing'}`}>
                    {lineLoc ? `${lineLoc.display} · ${lineLoc.slot}`.toUpperCase() : 'NO LOCATION'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      {showActions && (
        <div className="app-order-row-actions">
          {showPackaged && onPackaged && (
            <button type="button" className="app-order-action-primary" disabled={packagedBusy} onClick={onPackaged}>
              {packagedBusy ? '…' : 'Packaged'}
            </button>
          )}
          {hasLabel(lead) && onPrint && (
            <button type="button" className="app-order-action-outline" onClick={onPrint}>Print</button>
          )}
          {showAddWeight && onAddWeight && (
            <button type="button" className="app-order-action-outline" onClick={onAddWeight}>
              Add weight
            </button>
          )}
          {showUpload && onUpload && (
            <label className="app-order-action-outline app-order-upload-v2">
              Upload
              <input type="file" accept="application/pdf,image/*" onChange={(e) => {
                const f = e.target.files?.[0]; e.target.value = ''; if (f) onUpload(f);
              }} />
            </label>
          )}
          {showMarkShipped && onMarkShipped && (
            <button type="button" className="app-order-action-primary app-order-mark-ship" onClick={onMarkShipped}>
              Mark shipped
            </button>
          )}
          {showUnbundle && onUnbundle && (
            <button type="button" className="app-order-action-outline" disabled={unbundleBusy} onClick={onUnbundle}>
              Unbundle
            </button>
          )}
        </div>
      )}
    </div>
  );
}
