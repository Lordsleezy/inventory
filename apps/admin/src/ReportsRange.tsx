import { AppScrollTabs } from './appMode/AppScrollTabs';

type Kind = 'day' | 'week' | 'month' | 'all';

export function ReportsRange({ range, label, onPick, native }: {
  range: Kind | 'custom';
  label: string;
  onPick: (kind: Kind) => void;
  native?: boolean;
}) {
  const items: { id: Kind; label: string }[] = [
    { id: 'day', label: 'Day' },
    { id: 'week', label: 'Week' },
    { id: 'month', label: 'Month' },
    { id: 'all', label: 'All' },
  ];
  if (native) {
    const seg = range === 'custom' ? 'month' : range;
    return (
      <div className="rpt-range rpt-range-native">
        <AppScrollTabs ariaLabel="Report period" className="rpt-range-tabs" items={items} value={seg} onChange={onPick} />
        <p className="rpt-range-label">{label}</p>
      </div>
    );
  }
  return (
    <div className="rpt-range">
      <div role="group" aria-label="Date range">
        {items.map((item) => (
          <button type="button" key={item.id} className={range === item.id ? 'on' : ''} onClick={() => onPick(item.id)}>{item.label}</button>
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
