import type { SupabaseClient } from '@supabase/supabase-js';
import type { WebOrder } from '../OrdersPage';
import { displayOrderTitle } from '../orderDisplay';
import { locationParts } from '../locationOrder';
import { hasLabel, orderNeedsLabel, orderChip } from '../orderStage';
import { UnitListThumb } from '../UnitListThumb';

type Props = {
  order: WebOrder;
  client: SupabaseClient;
  thumbPath: string | null;
  photoUrls: Record<string, string>;
  locationCode: string | undefined;
  money: (n: number) => string;
  channelName: string;
  trackingTail: string;
  onOpen: () => void;
  onPrint?: () => void;
  hideMoney?: boolean;
  onUrl: (path: string, url: string) => void;
  showUpload?: boolean;
  onUpload?: (file: File) => void;
};

export function AppOrderRow({
  order, client, thumbPath, photoUrls, locationCode, money, channelName, trackingTail,
  onOpen, onPrint, onUrl, showUpload, onUpload, hideMoney = false,
}: Props) {
  const loc = locationParts(locationCode);
  const chip = orderChip(order);
  const needsLabel = orderNeedsLabel(order);
  const problem = needsLabel || chip.tone === 'warn';
  const title = displayOrderTitle(order.title || order.marketplace_title);
  const meta = hideMoney
    ? [trackingTail].filter(Boolean).join(' · ')
    : needsLabel
      ? `${channelName} · ${money(order.item_cents || 0)}`
      : [channelName, money(order.item_cents || 0), trackingTail].filter(Boolean).join(' · ');
  const locLine = loc ? `${loc.display} · ${loc.slot}`.toUpperCase() : '';
  const showActions = Boolean((hasLabel(order) && onPrint) || (showUpload && onUpload));

  return (
    <div className={`app-row app-order-row-v2${needsLabel ? ' needs-label' : ''}`}>
      <button type="button" className="app-order-open-v2" onClick={onOpen}>
        <UnitListThumb
          client={client}
          photoPath={thumbPath}
          urls={photoUrls}
          onUrl={onUrl}
          className="app-order-thumb-v2"
          placeholder={<span className="app-order-thumb-v2 no-photo">No photo</span>}
        />
        <span className="app-order-copy">
          <span className="app-order-title">{title}</span>
          <span className="app-order-sku-line"><span className="lbl">SKU</span> <strong>{order.sku || '—'}</strong></span>
          <span className="app-order-meta">{meta}</span>
          <span className={`app-order-loc${loc ? '' : ' missing'}`}>{locLine || 'NO LOCATION'}</span>
          {problem && (
            <span className="app-order-problem">{needsLabel ? 'Needs label' : chip.text}</span>
          )}
        </span>
      </button>
      {showActions && (
        <div className="app-order-row-actions">
          {hasLabel(order) && onPrint && (
            <button type="button" className="app-order-action-outline" onClick={(e) => { e.stopPropagation(); onPrint(); }}>Print</button>
          )}
          {showUpload && onUpload && (
            <label className="app-order-action-outline app-order-upload-v2" onClick={(e) => e.stopPropagation()}>
              Upload
              <input type="file" accept="application/pdf,image/*" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onUpload(f); }} />
            </label>
          )}
        </div>
      )}
    </div>
  );
}
