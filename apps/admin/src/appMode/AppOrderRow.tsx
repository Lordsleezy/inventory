import type { SupabaseClient } from '@supabase/supabase-js';
import type { WebOrder } from '../OrdersPage';
import { displayOrderTitle } from '../orderDisplay';
import { locationParts } from '../locationOrder';
import { hasLabel, orderNeedsLabel, orderNeedsWeightVerify, orderChip } from '../orderStage';
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
  /** Verify weight tab: open the order to enter weight (not a label upload). */
  showAddWeight?: boolean;
  onAddWeight?: () => void;
  showStepBack?: boolean;
  onStepBack?: () => void;
  showPackaged?: boolean;
  onPackaged?: () => void;
  packagedBusy?: boolean;
  showMarkShipped?: boolean;
  onMarkShipped?: () => void;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  suggestHint?: string;
};

export function AppOrderRow({
  order, client, thumbPath, photoUrls, locationCode, money, channelName, trackingTail,
  onOpen, onPrint, onUrl, showUpload, onUpload, showAddWeight, onAddWeight,
  hideMoney = false, showStepBack, onStepBack,
  showPackaged, onPackaged, packagedBusy, showMarkShipped, onMarkShipped,
  selectMode = false, selected = false, onToggleSelect, suggestHint,
}: Props) {
  const loc = locationParts(locationCode);
  const chip = orderChip(order);
  const needsLabel = orderNeedsLabel(order);
  const needsWeight = orderNeedsWeightVerify(order);
  const problem = needsWeight || needsLabel || chip.tone === 'warn';
  const title = displayOrderTitle(order.title || order.marketplace_title);
  const meta = hideMoney
    ? [trackingTail].filter(Boolean).join(' · ')
    : needsLabel || needsWeight
      ? `${channelName} · ${money(order.item_cents || 0)}`
      : [channelName, money(order.item_cents || 0), trackingTail].filter(Boolean).join(' · ');
  const locLine = loc ? `${loc.display} · ${loc.slot}`.toUpperCase() : '';
  const showActions = Boolean(
    (hasLabel(order) && onPrint)
    || (showAddWeight && onAddWeight)
    || (showUpload && onUpload)
    || (showStepBack && onStepBack)
    || (showPackaged && onPackaged)
    || (showMarkShipped && onMarkShipped),
  );
  const problemText = needsWeight ? 'Verify weight' : needsLabel ? 'Needs label' : chip.text;

  return (
    <div className={`app-row app-order-row-v2${needsLabel || needsWeight ? ' needs-label' : ''}${selected ? ' selected' : ''}`}>
      <div className="app-order-row-mainline">
        {selectMode && (
          <label className="app-order-check">
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect?.()}
              aria-label={`Select SKU ${order.sku}`}
            />
          </label>
        )}
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
            {suggestHint && <span className="app-order-suggest">{suggestHint}</span>}
            {problem && (
              <span className="app-order-problem">{problemText}</span>
            )}
          </span>
        </button>
      </div>
      {showActions && (
        <div className={`app-order-row-actions${selectMode ? ' with-check' : ''}`}>
          {showPackaged && onPackaged && (
            <button
              type="button"
              className="app-order-action-primary"
              disabled={packagedBusy}
              onClick={(e) => { e.stopPropagation(); onPackaged(); }}
            >
              {packagedBusy ? '…' : 'Packaged'}
            </button>
          )}
          {hasLabel(order) && onPrint && (
            <button type="button" className="app-order-action-outline" onClick={(e) => { e.stopPropagation(); onPrint(); }}>Print</button>
          )}
          {showAddWeight && onAddWeight && (
            <button
              type="button"
              className="app-order-action-outline"
              onClick={(e) => { e.stopPropagation(); onAddWeight(); }}
            >
              Add weight
            </button>
          )}
          {showUpload && onUpload && (
            <label className="app-order-action-outline app-order-upload-v2" onClick={(e) => e.stopPropagation()}>
              Upload
              <input type="file" accept="application/pdf,image/*" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onUpload(f); }} />
            </label>
          )}
          {showStepBack && onStepBack && (
            <button
              type="button"
              className="app-order-action-outline"
              onClick={(e) => { e.stopPropagation(); onStepBack(); }}
            >
              Step back
            </button>
          )}
          {showMarkShipped && onMarkShipped && (
            <button
              type="button"
              className="app-order-action-primary app-order-mark-ship"
              onClick={(e) => { e.stopPropagation(); onMarkShipped(); }}
            >
              Mark shipped
            </button>
          )}
        </div>
      )}
    </div>
  );
}
