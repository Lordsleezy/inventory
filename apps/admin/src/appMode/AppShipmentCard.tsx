import type { SupabaseClient } from '@supabase/supabase-js';
import type { WebOrder } from '../OrdersPage';
import { displayOrderTitle } from '../orderDisplay';
import { locationParts } from '../locationOrder';
import { hasLabel, orderNeedsLabel } from '../orderStage';
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
  selected: boolean;
  selectMode: boolean;
  onToggleSelect: () => void;
  onOpen: (order: WebOrder) => void;
  onUrl: (path: string, url: string) => void;
  showUpload?: boolean;
  onUpload?: (file: File) => void;
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

export function AppShipmentCard({
  shipment, client, photoMap, photoUrls, locations, money, channelName, trackingTail,
  selected, selectMode, onToggleSelect, onOpen, onUrl,
  showUpload, onUpload, onPrint, showPackaged, onPackaged, packagedBusy,
  showMarkShipped, onMarkShipped, showUnbundle, onUnbundle, unbundleBusy,
  expanded, onToggleExpand, hideMoney = false,
}: Props) {
  const lead = shipment.lead;
  const needsLabel = orderNeedsLabel(lead);
  const loc = locationParts(locations[lead.sku]?.[0]);
  const leadTitle = displayOrderTitle(lead.title || lead.marketplace_title);
  const thumbPhoto = listThumbPhoto(photoMap[lead.sku] || []);
  const pkg = shipment.package;
  const meta = hideMoney
    ? [trackingTail].filter(Boolean).join(' · ')
    : needsLabel
      ? `${channelName} · ${shipment.itemCount} items`
      : [channelName, `${shipment.itemCount} items`, trackingTail].filter(Boolean).join(' · ');
  const locLine = loc ? `${loc.display} · ${loc.slot}`.toUpperCase() : '';
  const showActions = Boolean(
    (hasLabel(lead) && onPrint) || (showUpload && onUpload) || (showPackaged && onPackaged)
    || (showMarkShipped && onMarkShipped) || (showUnbundle && onUnbundle),
  );

  if (!shipment.bundled) {
    const order = lead;
    const title = displayOrderTitle(order.title || order.marketplace_title);
    const orderLoc = locationParts(locations[order.sku]?.[0]);
    const orderMeta = hideMoney
      ? [trackingTail].filter(Boolean).join(' · ')
      : needsLabel
        ? `${channelName} · ${money(order.item_cents || 0)}`
        : [channelName, money(order.item_cents || 0), trackingTail].filter(Boolean).join(' · ');
    return (
      <div className={`app-row app-order-row-v2${needsLabel ? ' needs-label' : ''}${selected ? ' selected' : ''}`}>
        <div className="app-order-row-mainline">
          {selectMode && (
            <label className="app-order-check">
              <input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label={`Select SKU ${order.sku}`} />
            </label>
          )}
          <button type="button" className="app-order-open-v2" onClick={() => onOpen(order)}>
            <UnitListThumb
              client={client}
              photoPath={thumbPhoto?.path || null}
              urls={photoUrls}
              onUrl={onUrl}
              className="app-order-thumb-v2"
              placeholder={<span className="app-order-thumb-v2 no-photo">No photo</span>}
            />
            <span className="app-order-copy">
              <span className="app-order-title">{title}</span>
              <span className="app-order-sku-line"><span className="lbl">SKU</span> <strong>{order.sku || '—'}</strong></span>
              <span className="app-order-meta">{orderMeta}</span>
              <span className={`app-order-loc${orderLoc ? '' : ' missing'}`}>
                {orderLoc ? `${orderLoc.display} · ${orderLoc.slot}`.toUpperCase() : 'NO LOCATION'}
              </span>
              {needsLabel && <span className="app-order-problem">Needs label</span>}
            </span>
          </button>
        </div>
        {showActions && (
          <div className="app-order-row-actions">
            {showPackaged && onPackaged && (
              <button type="button" className="app-order-action-primary" disabled={packagedBusy} onClick={onPackaged}>
                {packagedBusy ? '…' : 'Packaged'}
              </button>
            )}
            {hasLabel(order) && onPrint && (
              <button type="button" className="app-order-action-outline" onClick={onPrint}>Print</button>
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
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`app-row app-shipment-card${needsLabel ? ' needs-label' : ''}${selected ? ' selected' : ''}`}>
      <div className="app-order-row-mainline">
        {selectMode && (
          <label className="app-order-check">
            <input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label={`Select ${shipment.itemCount}-item shipment`} />
          </label>
        )}
        <button type="button" className="app-order-open-v2" onClick={onToggleExpand}>
          <span className="app-shipment-thumbs">
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
            <span className="app-order-sku-line">{leadTitle}</span>
            <span className="app-order-meta">{meta}</span>
            {pkg && (
              <span className="app-order-meta">
                Box {pkg.length_in}×{pkg.width_in}×{pkg.height_in} in · {pkg.weight_lb} lb
              </span>
            )}
            <span className={`app-order-loc${loc ? '' : ' missing'}`}>{locLine || 'NO LOCATION'}</span>
            {needsLabel && <span className="app-order-problem">Needs label</span>}
          </span>
        </button>
      </div>
      {expanded && (
        <div className="app-shipment-lines">
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
                  <span className="app-order-title">{displayOrderTitle(order.title || order.marketplace_title)}</span>
                  <span className="app-order-sku-line"><span className="lbl">SKU</span> <strong>{order.sku}</strong></span>
                  <span className={`app-order-loc${lineLoc ? '' : ' missing'}`}>
                    {lineLoc ? `${lineLoc.display} · ${lineLoc.slot}`.toUpperCase() : 'NO LOCATION'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
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
