import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DeskPulse } from './deskPulse';
import { loadHomeDesk, type ChannelLine, type HomeDesk, type OwedPerson } from './homeDesk';
import { dayPart, firstName } from './homeGreeting';
import type { NavState } from './navigation';
import { ASSOCIATE_LINKS, OWNER_LINKS, type DeskAccess } from './deskNav';

type Props = {
  displayName: string | null;
  email: string | null;
  deskAccess: DeskAccess;
  pulse: DeskPulse;
  client: SupabaseClient;
  accessToken: string;
  storeId: string;
  money: (cents: number) => string;
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
  const hour = Number(parts.hour);
  const part = dayPart(hour);
  const hello = part === 'morning' ? 'Good morning' : part === 'afternoon' ? 'Good afternoon' : 'Good evening';
  return { hello, date: `${parts.weekday}, ${parts.month} ${parts.day}` };
}

function clock(iso: string) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
}

function channelName(raw: string) {
  const n = raw.toLowerCase();
  if (n === 'ebay') return 'eBay';
  if (n === 'depop') return 'Depop';
  if (n.includes('square') || n.includes('store') || n === 'register' || n === 'website') return 'In store';
  if (n === 'mercari') return 'Mercari';
  if (n === 'amazon') return 'Amazon';
  if (n === 'tiktok') return 'TikTok';
  return raw || 'Sale';
}

export function HomePage({ displayName, email, deskAccess, pulse, client, accessToken, storeId, money, onOpen }: Props) {
  const name = firstName(displayName, email);
  const [{ hello, date }] = useState(laNow);
  const [desk, setDesk] = useState<HomeDesk | null>(null);
  const fullAccess = deskAccess === 'admin';
  const deskLinks = deskAccess === 'owner' ? OWNER_LINKS : ASSOCIATE_LINKS;

  useEffect(() => {
    if (!fullAccess || !storeId) return;
    let alive = true;
    void loadHomeDesk(client, accessToken, storeId, pulse).then((next) => { if (alive) setDesk(next); }).catch(() => undefined);
    return () => { alive = false; };
  }, [fullAccess, storeId, client, accessToken, pulse]);

  const owed = desk?.owed || [];
  const owedTotal = owed.reduce((n, row) => n + row.cents, 0);
  const needs: { title: string; note: string; action: string; patch: Partial<NavState> }[] = [];
  const labels = pulse.needsLabel || 0;
  const issues = pulse.listingIssues || 0;
  const missing = desk?.missingCost || 0;
  const untracked = desk?.returnsUntracked || 0;
  const bookCount = desk?.booksIssues?.count || 0;
  if (labels > 0) needs.push({ title: `${labels} order${labels === 1 ? '' : 's'} need${labels === 1 ? 's' : ''} a label`, note: 'Buy or upload labels before they ship late', action: 'Open orders', patch: { page: 'orders' } });
  if (issues > 0) needs.push({ title: `${issues} listing issue${issues === 1 ? '' : 's'}`, note: 'Items that failed to list or sync', action: 'Review', patch: { page: 'inventory', inventoryTab: 'in-stock' } });
  if (missing > 0) needs.push({ title: `${missing} item${missing === 1 ? '' : 's'} missing cost`, note: 'No payout is calculated until cost is entered', action: 'Add costs', patch: { page: 'inventory', inventoryTab: 'unfinished', attentionSection: 'missing-cost' } });
  if (untracked > 0) needs.push({ title: `${untracked} open return${untracked === 1 ? '' : 's'} · no tracking`, note: 'Add tracking so status updates on its own', action: 'Open returns', patch: { page: 'returns' } });
  if (bookCount > 0) needs.push({ title: `${bookCount} thing${bookCount === 1 ? '' : 's'} to fix before you lock ${desk?.booksIssues?.month}`, note: 'Books', action: 'Open Books', patch: { page: 'books' } });

  return (
    <div className="desk-home">
      <p className="desk-date">{date}</p>
      <h1 className="desk-hello">{hello}, {name}.</h1>
      {!fullAccess && (
        <>
          <div className="desk-attention">
            <button type="button" onClick={() => onOpen({ page: 'orders' })}>
              <span>To ship</span>
              <strong>{pulse.toShip == null ? '…' : pulse.toShip}</strong>
            </button>
          </div>
          {pulse.toShip != null && pulse.toShip > 0 && (
            <section className="desk-staff-needs">
              <h2>Needs you</h2>
              <div className="desk-need">
                <div>
                  <strong>{pulse.toShip} order{pulse.toShip === 1 ? '' : 's'} to ship</strong>
                  <span>Pick, label, and mark packaged</span>
                </div>
                <button type="button" onClick={() => onOpen({ page: 'orders' })}>Open orders</button>
              </div>
            </section>
          )}
          <div className="desk-grid is-associate">
            <section>
              <h2>Your desk</h2>
              {deskLinks.map((link) => (
                <button
                  key={link.label}
                  type="button"
                  onClick={() => onOpen({
                    page: link.page,
                    ...(link.inventoryTab ? { inventoryTab: link.inventoryTab } : {}),
                  })}
                >
                  {link.label}
                  <span>{link.hint}</span>
                </button>
              ))}
            </section>
          </div>
        </>
      )}
      {fullAccess && (
        <>
          <div className="desk-home-strip">
            <div>
              <span>Sales today</span>
              <strong>{pulse.salesCents == null ? '…' : money(pulse.salesCents)}</strong>
              <small>{pulse.salesToday == null ? '' : `${pulse.salesToday} sale${pulse.salesToday === 1 ? '' : 's'}`}</small>
            </div>
            <div>
              <span>To ship</span>
              <strong>{pulse.toShip == null ? '…' : pulse.toShip}</strong>
            </div>
            <div className={(pulse.needsLabel || 0) > 0 ? 'is-alert' : ''}>
              <span>Needs label</span>
              <strong>{pulse.needsLabel == null ? '…' : pulse.needsLabel}</strong>
            </div>
            <div>
              <span>Open returns</span>
              <strong>{pulse.openReturns == null ? '…' : pulse.openReturns}</strong>
            </div>
            <div>
              <span>Owed out</span>
              <strong>{desk ? money(owedTotal) : '…'}</strong>
              <small>{owedLine(owed, money)}</small>
            </div>
          </div>
          <div className="desk-home-columns">
            <section>
              <h2>Needs you</h2>
              {needs.length === 0 && <p className="desk-quiet">Nothing waiting.</p>}
              {needs.map((row) => (
                <div key={row.title} className="desk-need">
                  <div>
                    <strong>{row.title}</strong>
                    <span>{row.note}</span>
                  </div>
                  <button type="button" onClick={() => onOpen(row.patch)}>{row.action}</button>
                </div>
              ))}
            </section>
            <section>
              <div className="desk-section-head">
                <h2>Today's sales</h2>
                <button type="button" className="desk-text" onClick={() => onOpen({ page: 'sales' })}>Live Sales</button>
              </div>
              {pulse.recentSales.length === 0 && <p className="desk-quiet">No sales yet today.</p>}
              {pulse.recentSales.map((sale) => (
                <div key={sale.at + sale.title} className="desk-sale">
                  <span>{clock(sale.at)}</span>
                  <strong>{sale.title}</strong>
                  <em>{channelName(sale.channel)}</em>
                  <b>{money(sale.price_cents)}</b>
                </div>
              ))}
              <h2 className="desk-channels-title">Channels</h2>
              {(desk?.channels || []).map((row) => <Channel key={row.name} row={row} />)}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function owedLine(rows: OwedPerson[], money: (cents: number) => string) {
  if (!rows.length) return '';
  return rows.map((row) => `${row.name} ${money(row.cents)}`).join(' · ');
}

function Channel({ row }: { row: ChannelLine }) {
  return (
    <div className="desk-channel">
      <strong>{row.name}</strong>
      <span>{row.detail}</span>
      <em>{row.when}</em>
    </div>
  );
}
