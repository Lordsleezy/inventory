import { useState } from 'react';
import { ASSOCIATE_LINKS, DESK_GROUPS, HOME_INVENTORY_LINKS, HOME_REPORT_LINKS, type DeskLink } from './deskNav';
import type { DeskPulse } from './deskPulse';
import { dayPart, firstName, GREETING_STORAGE_KEY, pickGreeting } from './homeGreeting';
import type { NavState } from './navigation';

type Props = {
  displayName: string | null;
  email: string | null;
  fullAccess: boolean;
  pulse: DeskPulse;
  onOpen: (patch: Partial<NavState>) => void;
};

function laNow() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    hour: Number(parts.hour),
    date: `${parts.weekday}, ${parts.month} ${parts.day}`,
  };
}

function attentionValue(n: number | null) {
  return n == null ? '…' : String(n);
}

export function HomePage({ displayName, email, fullAccess, pulse, onOpen }: Props) {
  const name = firstName(displayName, email);
  const [{ line, date }] = useState(() => {
    const now = laNow();
    let previous: string | null = null;
    try { previous = sessionStorage.getItem(GREETING_STORAGE_KEY); } catch { /* private mode */ }
    const next = pickGreeting(dayPart(now.hour), previous);
    try { sessionStorage.setItem(GREETING_STORAGE_KEY, next); } catch { /* ignore */ }
    return { line: next, date: now.date };
  });

  const groups = fullAccess ? DESK_GROUPS : [{ label: 'Your desk', links: ASSOCIATE_LINKS }];

  const attention: { label: string; value: string; danger: boolean; patch: Partial<NavState> }[] = [
    { label: 'To ship', value: attentionValue(pulse.toShip), danger: false, patch: { page: 'orders' } },
    { label: 'Needs label', value: attentionValue(pulse.needsLabel), danger: (pulse.needsLabel || 0) > 0, patch: { page: 'orders' } },
    { label: 'Open returns', value: attentionValue(pulse.openReturns), danger: false, patch: { page: 'returns' } },
    { label: 'Listing issues', value: attentionValue(pulse.listingIssues), danger: (pulse.listingIssues || 0) > 0, patch: { page: 'inventory', inventoryTab: 'in-stock' } },
    { label: 'Sales today', value: attentionValue(pulse.salesToday), danger: false, patch: { page: 'sales' } },
  ];

  return (
    <div className="desk-home">
      <p className="desk-date">{date}</p>
      <h1 className="desk-hello">{line}, {name}.</h1>
      {fullAccess && (
        <div className="desk-attention" role="list">
          {attention.map((item) => (
            <button type="button" key={item.label} className={item.danger ? 'is-alert' : ''} onClick={() => onOpen(item.patch)}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </button>
          ))}
        </div>
      )}
      <div className={`desk-grid${fullAccess ? '' : ' is-associate'}`}>
        {groups.map((group) => (
          <section key={group.label}>
            <h2>{group.label}</h2>
            {group.links.map((link) => (
              <button type="button" key={link.page + link.label} onClick={() => onOpen(linkToNav(link))}>
                <strong>{link.label}</strong>
                <span>{hintFor(link, pulse)}</span>
              </button>
            ))}
            {fullAccess && group.label === 'Stock' && (
              <div className="desk-sub">
                {HOME_INVENTORY_LINKS.map((link) => (
                  <button type="button" key={link.label} onClick={() => onOpen(linkToNav(link))}>{link.label}</button>
                ))}
              </div>
            )}
            {fullAccess && group.label === 'Money' && (
              <div className="desk-sub">
                {HOME_REPORT_LINKS.map((link) => (
                  <button type="button" key={link.label} onClick={() => onOpen(linkToNav(link))}>{link.label}</button>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

function linkToNav(link: DeskLink): Partial<NavState> {
  return {
    page: link.page,
    ...(link.inventoryTab ? { inventoryTab: link.inventoryTab } : {}),
    ...(link.reportTab ? { reportTab: link.reportTab } : {}),
  };
}

function hintFor(link: DeskLink, pulse: DeskPulse) {
  if (link.page === 'orders' && pulse.toShip != null) return `${pulse.toShip} to ship`;
  if (link.page === 'ebay' && pulse.ebayListed != null) return `${pulse.ebayListed.toLocaleString('en-US')} listed`;
  if (link.page === 'depop' && pulse.depopListed != null) return `${pulse.depopListed.toLocaleString('en-US')} live`;
  if (link.page === 'dropship' && pulse.dropship) return pulse.dropship;
  return link.hint;
}
