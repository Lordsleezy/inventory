import type { OrderStage, TimelineRow } from './orderStage';
import { STAGE_INDEX, carrierTrackUrl } from './orderStage';

const STEPS = ['To ship', 'Packaged', 'Shipped', 'Delivered'] as const;

export function OrderStepper({ stage }: { stage: OrderStage }) {
  const current = STAGE_INDEX[stage] ?? -1;
  if (current < 0) return null;
  return (
    <ol className="order-stepper" aria-label="Order progress">
      {STEPS.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'later';
        return (
          <li key={label} className={state}>
            <span>{i < current ? '✓' : i + 1}</span>
            <small>{label}</small>
          </li>
        );
      })}
    </ol>
  );
}

export function OrderTrackLine({ order }: { order: { tracking_number?: string | null; carrier?: string | null } }) {
  const href = carrierTrackUrl(order.tracking_number, order.carrier);
  if (!order.tracking_number) return null;
  return (
    <p className="hint">
      {order.carrier ? `${order.carrier} ` : ''}{order.tracking_number}
      {href && <> · <a href={href} target="_blank" rel="noreferrer">Track</a></>}
    </p>
  );
}

export function OrderTimelineList({ rows, stamp }: { rows: TimelineRow[]; stamp: (s: string) => string }) {
  if (!rows.length) return null;
  return (
    <ol className="order-timeline">
      {rows.map((row, i) => (
        <li key={`${row.title}-${row.at || i}`} className={row.tone || (i === 0 ? 'current' : '')}>
          <strong>{row.title}</strong>
          <span>{[row.detail, row.at ? stamp(row.at) : ''].filter(Boolean).join(' · ')}</span>
        </li>
      ))}
    </ol>
  );
}
