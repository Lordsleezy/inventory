import { useEffect, useRef, useState } from 'react';
import type { WebOrder } from '../OrdersPage';
import { carrierTrackUrl } from '../orderStage';
import { formatTrackingDisplay, matchesOrderTracking, trackingExpectTail } from '../trackingNormalize';

type Props = {
  order: WebOrder;
  isAdmin: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (barcode: string, overrideReason?: string) => void;
};

export function AppOrderShipVerifySheet({ order, isAdmin, busy, onClose, onConfirm }: Props) {
  const [draft, setDraft] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const track = order.tracking_number || order.marketplace_tracking_number;
  const hasTrack = Boolean((track || '').trim());
  const carrier = order.carrier || 'USPS';
  const match = hasTrack ? matchesOrderTracking(order, draft) : false;
  const showMismatch = draft.trim().length >= 8 && hasTrack && !match;
  const canOverride = isAdmin && !hasTrack && overrideReason.trim().length >= 4;
  const canConfirm = !busy && (match || canOverride);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="app-order-verify-sheet" role="dialog" aria-modal="true" aria-labelledby="verify-ship-title">
      <button type="button" className="app-order-verify-scrim" aria-label="Close" onClick={onClose} />
      <div className="app-order-verify-panel">
        <div className="app-order-verify-grab" aria-hidden />
        <h2 id="verify-ship-title" className="app-order-verify-title">Verify package</h2>
        <p className="app-order-verify-sub">Scan the label or type the tracking number before handing it off.</p>

        {!hasTrack && (
          <p className="app-order-verify-warn">
            {isAdmin
              ? 'No tracking number on file. Enter a scan anyway, or record why you are shipping without one.'
              : 'No tracking number on file. Ask an admin to fix the order before handing it off.'}
          </p>
        )}

        <div className="app-order-verify-row">
          <input
            ref={inputRef}
            className="app-order-verify-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canConfirm) { e.preventDefault(); onConfirm(draft.trim(), canOverride ? overrideReason.trim() : undefined); } }}
            placeholder="Tracking number"
            autoComplete="off"
            inputMode="text"
            enterKeyHint="done"
            disabled={!hasTrack && !isAdmin}
          />
          <button
            type="button"
            className="app-order-verify-scan"
            onClick={() => inputRef.current?.focus()}
          >
            Scan
          </button>
        </div>

        {hasTrack && (
          <p className="app-order-verify-hint">
            Expecting {carrier} ending {trackingExpectTail(order)}
          </p>
        )}
        {showMismatch && (
          <p className="app-order-verify-err">Doesn&apos;t match this order — check the package</p>
        )}

        {isAdmin && !hasTrack && (
          <label className="app-order-verify-override">
            <span className="eyebrow">Admin override reason</span>
            <input
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="Why there is no tracking"
              disabled={busy}
            />
          </label>
        )}

        {hasTrack && track && (
          <p className="app-order-verify-file-hint subtle">
            On label: {formatTrackingDisplay(carrier, track)}
            {carrierTrackUrl(track, carrier) ? (
              <> · <a href={carrierTrackUrl(track, carrier)!} target="_blank" rel="noreferrer">Track</a></>
            ) : null}
          </p>
        )}

        <div className="app-order-verify-actions">
          <button type="button" className="app-order-verify-cancel" disabled={busy} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="app-order-verify-confirm"
            disabled={!canConfirm}
            onClick={() => onConfirm(draft.trim(), canOverride ? overrideReason.trim() : undefined)}
          >
            {busy ? '…' : 'Confirm shipped'}
          </button>
        </div>
      </div>
    </div>
  );
}
