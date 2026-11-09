import type { OrderStage } from '../orderStage';
import { STAGE_INDEX } from '../orderStage';

const STEPS = ['To ship', 'Packaged', 'Shipped', 'Delivered'] as const;

export function AppOrderStageLine({ stage }: { stage: OrderStage }) {
  const current = STAGE_INDEX[stage] ?? -1;
  if (current < 0 || current > 3) return null;
  return (
    <div className="app-order-stage-line" aria-label="Order progress">
      {STEPS.map((label, i) => (
        <span
          key={label}
          className={[
            'app-order-stage-node',
            i < current ? 'done' : '',
            i === current ? 'on' : '',
          ].filter(Boolean).join(' ')}
        >
          <span className="app-order-stage-dot" aria-hidden />
          <span className="app-order-stage-label">{label}</span>
        </span>
      ))}
    </div>
  );
}
