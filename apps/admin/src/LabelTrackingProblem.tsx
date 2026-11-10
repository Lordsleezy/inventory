import { useState } from 'react';
import type { WebOrder } from './OrdersPage';
import { parseLabelMismatch } from './labelTrackingMismatch';
import { classifyCarrierHint } from './labelTrackingValidate';

type Props = {
  order: WebOrder;
  busy?: boolean;
  onUseMarketplace: () => void;
  onUseLabel: (number: string, carrier: string) => void;
  onManual: (number: string, carrier: string) => void;
  onRetry: () => void;
  onReplace: () => void;
};

function carrierFor(number: string) {
  return classifyCarrierHint(number).carrier || 'USPS';
}

export function LabelTrackingProblem({
  order, busy, onUseMarketplace, onUseLabel, onManual, onRetry, onReplace,
}: Props) {
  const mismatch = order.label_tracking_mismatch ? parseLabelMismatch(order.tracking_exception) : null;
  const market = order.marketplace_tracking_number?.replace(/\s+/g, '') || mismatch?.marketplace || '';
  const labelNum = mismatch?.label || '';
  const [draft, setDraft] = useState(market || labelNum || '');
  const unreadable = !mismatch && Boolean(order.tracking_needs_entry && !order.tracking_number);
  const warn = draft.length >= 8 && !classifyCarrierHint(draft).ok;

  if (!mismatch && !unreadable && !order.tracking_exception) return null;

  return (
    <div className="label-tracking-problem" role="alert">
      {mismatch ? (
        <>
          <p className="label-tracking-problem-title">The label we read doesn&apos;t match eBay&apos;s tracking number.</p>
          <div className="label-tracking-problem-nums">
            <p><span className="eyebrow">From label</span><strong>{mismatch.labelGrouped}</strong></p>
            <p><span className="eyebrow">eBay says</span><strong>{mismatch.marketplaceGrouped}</strong></p>
          </div>
        </>
      ) : unreadable ? (
        <p className="label-tracking-problem-title">Couldn&apos;t read tracking from this label. Enter it below or try again.</p>
      ) : (
        <p className="label-tracking-problem-title">{order.tracking_exception}</p>
      )}

      <div className="label-tracking-problem-actions">
        {market && (
          <button type="button" className="secondary" disabled={busy} onClick={onUseMarketplace}>
            Use eBay&apos;s number
            <small>USPS {mismatch?.marketplaceGrouped || market}</small>
          </button>
        )}
        {mismatch && labelNum && (
          <button type="button" className="secondary" disabled={busy} onClick={() => onUseLabel(labelNum, carrierFor(labelNum))}>
            Use label&apos;s number
            <small>{carrierFor(labelNum)} {mismatch.labelGrouped}</small>
          </button>
        )}
        <button type="button" className="secondary" disabled={busy} onClick={onRetry}>Try again</button>
        <button type="button" className="secondary" disabled={busy} onClick={onReplace}>Replace label</button>
      </div>

      <form
        className="label-tracking-problem-manual"
        onSubmit={(e) => {
          e.preventDefault();
          onManual(draft.trim(), carrierFor(draft));
        }}
      >
        <label>
          <span className="eyebrow">Enter manually</span>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Tracking number" autoComplete="off" />
        </label>
        {warn && <p className="label-tracking-problem-warn">This number didn&apos;t pass the carrier check digit — you can still save it.</p>}
        <button type="submit" className="secondary" disabled={busy || draft.trim().length < 8}>Save tracking</button>
      </form>
    </div>
  );
}
