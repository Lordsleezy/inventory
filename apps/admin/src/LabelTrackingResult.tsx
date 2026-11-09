import { useCallback } from 'react';

export type LabelTrackingHit = {
  carrier?: string | null;
  number: string;
  layer?: string | null;
};

type Props = {
  hit: LabelTrackingHit;
  className?: string;
  onDismiss?: () => void;
};

export function LabelTrackingResult({ hit, className = '', onDismiss }: Props) {
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(hit.number);
  }, [hit.number]);

  return (
    <div className={`label-tracking-result${className ? ` ${className}` : ''}`} role="status">
      <div className="label-tracking-result-head">
        <span className="eyebrow">Detected tracking</span>
        {onDismiss && <button type="button" className="text-button" onClick={onDismiss}>Dismiss</button>}
      </div>
      <p className="label-tracking-result-line">
        <strong>{hit.carrier || 'Carrier'}</strong>
        <span className="label-tracking-result-num">{hit.number}</span>
      </p>
      <button type="button" className="secondary" onClick={copy}>Copy</button>
    </div>
  );
}

type PickerProps = {
  candidates: { number: string; carrier?: string | null; source?: string | null }[];
  busy?: boolean;
  onPick: (number: string, carrier?: string | null) => void;
  onManual: () => void;
};

export function LabelTrackingPicker({ candidates, busy, onPick, onManual }: PickerProps) {
  return (
    <div className="label-tracking-picker" role="dialog" aria-label="Choose tracking number">
      <p className="eyebrow">Which tracking number?</p>
      <ul>
        {candidates.map((c) => (
          <li key={c.number}>
            <button type="button" disabled={busy} onClick={() => onPick(c.number, c.carrier)}>
              <strong>{c.carrier || 'USPS'}</strong> {c.number}
              {c.source && <small>{c.source}</small>}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="secondary" disabled={busy} onClick={onManual}>Enter manually</button>
    </div>
  );
}
