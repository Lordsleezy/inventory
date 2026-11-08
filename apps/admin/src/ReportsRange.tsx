type Kind = 'day' | 'week' | 'month' | 'all';

export function ReportsRange({ range, label, onPick }: {
  range: Kind | 'custom';
  label: string;
  onPick: (kind: Kind) => void;
}) {
  const items: [Kind, string][] = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['all', 'All']];
  return (
    <div className="rpt-range">
      <div role="group" aria-label="Date range">
        {items.map(([id, text]) => (
          <button type="button" key={id} className={range === id ? 'on' : ''} onClick={() => onPick(id)}>{text}</button>
        ))}
      </div>
      <span>{label}</span>
    </div>
  );
}

/** Inclusive last day. Channel reports store the end date as exclusive. */
export function inclusiveEnd(exclusive: string) {
  const d = new Date(`${exclusive}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function rangeLabel(start: string, exclusiveEnd: string) {
  const end = inclusiveEnd(exclusiveEnd);
  const fmt = (iso: string, withYear: boolean) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'America/Los_Angeles',
  });
  if (start.slice(0, 4) !== end.slice(0, 4)) return `${start.slice(0, 4)} – ${fmt(end, true)}`;
  return `${fmt(start, false)} – ${fmt(end, true)}`;
}
