import { useEffect, useRef, useState } from 'react';
import type { WebOrder } from '../OrdersPage';
import { decodeBarcodeFile } from '../ReceivePanel';

type Props = {
  order: WebOrder;
  isAdmin: boolean;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: (barcode: string, overrideReason?: string) => void | Promise<void>;
};

/** Scan or type the label. The expected number is never shown. The server decides the match. */
export function AppOrderShipVerifySheet({ order, isAdmin, busy, error, onClose, onConfirm }: Props) {
  const [draft, setDraft] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [manual, setManual] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const title = order.title || order.marketplace_title || 'Order';

  useEffect(() => { inputRef.current?.focus(); }, [manual]);

  function submit(code = draft) {
    const barcode = code.trim();
    const reason = isAdmin ? overrideReason.trim() : '';
    if (!barcode && reason.length < 4) return;
    void onConfirm(barcode, reason.length >= 4 ? reason : undefined);
  }

  return (
    <div className="app-order-verify-sheet" role="dialog" aria-modal="true" aria-labelledby="verify-ship-title">
      <button type="button" className="app-order-verify-scrim" aria-label="Close" onClick={onClose} />
      <div className="app-order-verify-panel">
        <h2 id="verify-ship-title" className="app-order-verify-title">Scan the label to ship it</h2>
        <p className="app-order-verify-sub">{title} · SKU {order.sku || '—'}</p>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input
            ref={inputRef}
            className="app-order-verify-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={manual ? 'Tracking number' : 'Scan label barcode'}
            aria-label={manual ? 'Enter tracking' : 'Scan label barcode'}
            autoComplete="off"
            enterKeyHint="go"
            disabled={busy}
          />
        </form>
        <div className="scan-out-actions">
          <button type="button" className="scan-out-outline" disabled={busy} onClick={() => fileRef.current?.click()}>Use camera</button>
          <button type="button" className="scan-out-outline" disabled={busy} onClick={() => { setManual(true); inputRef.current?.focus(); }}>Enter tracking</button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="sr-only" aria-hidden tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            void decodeBarcodeFile(file).then((code) => { if (code) submit(code); });
          }} />
        {error && <p className="scan-out-err" role="alert">{error}</p>}
        {isAdmin && (
          <div className="app-order-verify-override">
            <label>
              <span className="eyebrow">Admin override, only if there is no tracking on file</span>
              <input
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
                placeholder="Why there is no tracking"
                aria-label="Why there is no tracking"
                enterKeyHint="go"
                disabled={busy}
              />
            </label>
            <button
              type="button"
              className="primary app-order-verify-ship"
              disabled={busy || overrideReason.trim().length < 4}
              onClick={() => submit()}
            >
              Mark shipped
            </button>
          </div>
        )}
        <button type="button" className="scan-out-quiet" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
