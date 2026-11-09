import { useEffect, useRef, useState } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { StaffSession } from '@floor/cloud';
import { RegisterPage } from '../RegisterPage';
import { MoneyPage } from '../MoneyPage';
import { BooksPage } from '../BooksPage';
import { ManifestsPage } from '../ManifestsPage';
import { LocationsPage } from '../LocationsPage';
import { InsightsPage } from '../InsightsPage';
import { AppInventory } from './AppInventory';
import { AppItemDetail } from './AppItemDetail';
import { AppReceive } from './AppReceive';
import { AppOrders } from './AppOrders';
import { ReturnsPage } from '../ReturnsPage';
import { AppChannel } from './AppChannel';
import {
  AppMoreHome,
  AppMoreOther,
  AppLiveSales,
  AppConnections,
  AppReportsNative,
  AppDepopNative,
  AppSettingsNative,
  type MoreId,
} from './AppMore';
import { DropshipPage } from '../dropship/DropshipPage';
import { ReceiptsPage } from '../ReceiptsPage';
import type { OnlineCfg, Rule, CommissionOverride } from '../payouts';
import { parseNavFromLocation } from '../navigation';
import { phoneTabIds } from '../deskNav';

export type AppTab = 'inventory' | 'receive' | 'register' | 'orders' | 'returns' | 'more' | 'settings' | 'locations';

type Props = {
  client: SupabaseClient;
  session: Session;
  storeId: string;
  fullAccess: boolean;
  /** Owner desk: staff floor tabs plus Reports / Safe / Manifests / Books under More. */
  ownerAccess?: boolean;
  staffSession: StaffSession | null;
  money: (n: number) => string;
  stamp: (s: string) => string;
  rules: Rule[];
  onlineCfg: OnlineCfg;
  commissionOverrides: Map<string, CommissionOverride>;
  personName: (id: string) => string;
  busy: boolean;
  onCommissionChanged: (ticketKey: string, next: CommissionOverride | null) => void;
  settingsSlot?: React.ReactNode;
  /** Full ReportsPage (profit / shipping / expenses / payouts / returns). */
  reportsSlot?: React.ReactNode;
  onReportsOpen?: () => void;
  reportsAction?: 'add' | 'download' | 'owner';
  onReportsAction?: () => void;
};

/** Clerk tab bar (max five). Admins use INVENTORY / RECEIVE / ORDERS / RETURNS / MORE. */
const TABS: { id: AppTab; label: string; icon: React.ReactNode; adminOnly?: boolean; associateOnly?: boolean }[] = [
  {
    id: 'inventory',
    label: 'Inventory',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 7h16v12H4z" /><path d="M8 7V5h8v2" />
      </svg>
    ),
  },
  {
    id: 'receive',
    label: 'Receive',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M13 3v10h4l-5 8-5-8h4V3z" />
      </svg>
    ),
  },
  {
    id: 'register',
    label: 'Register',
    associateOnly: true,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="8" /><path d="M12 7v10M9.5 9.5c.8-1 4.2-1 5 1s-1.5 2.5-2.5 2.5 3 1 2.5 3-3.5 1.2-4.5.2" />
      </svg>
    ),
  },
  {
    id: 'orders',
    label: 'Orders',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M7 7h10M7 12h10M7 17h6" /><path d="M4 4h16v16H4z" />
      </svg>
    ),
  },
  {
    id: 'returns',
    label: 'Returns',
    adminOnly: true,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 12a8 8 0 1 0 2.3-5.6" /><path d="M4 4v5h5" />
      </svg>
    ),
  },
  {
    id: 'more',
    label: 'More',
    adminOnly: true,
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <circle cx="6" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18" cy="12" r="1.6" />
      </svg>
    ),
  },
  {
    id: 'settings',
    label: 'Settings',
    associateOnly: true,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4l1.4-1.4M17 7l1.4-1.4" />
      </svg>
    ),
  },
  {
    id: 'locations',
    label: 'Locations',
    associateOnly: true,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M3 7h18M5 7v13h14V7M7 12h10M12 7v13" />
      </svg>
    ),
  },
];

export function AppModeShell({
  client,
  session,
  storeId,
  fullAccess,
  ownerAccess = false,
  staffSession,
  money,
  stamp,
  rules: _rules,
  onlineCfg: _onlineCfg,
  commissionOverrides: _commissionOverrides,
  personName: _personName,
  busy: _busy,
  onCommissionChanged: _onCommissionChanged,
  settingsSlot,
  reportsSlot,
  onReportsOpen,
  reportsAction,
  onReportsAction,
}: Props) {
  void _rules;
  void _onlineCfg;
  void _commissionOverrides;
  void _personName;
  void _busy;
  void _onCommissionChanged;
  const moneyAccess = fullAccess || ownerAccess;
  const [tab, setTab] = useState<AppTab>(() => {
    if (!fullAccess && !ownerAccess) return 'inventory';
    const page = parseNavFromLocation().page;
    if (fullAccess && page === 'returns') return 'returns';
    if (moneyAccess && ['reports', 'books', 'withdrawals', 'manifests'].includes(page)) return 'more';
    return 'inventory';
  });
  const [itemSku, setItemSku] = useState<string | null>(null);
  const [itemMissing, setItemMissing] = useState<string[]>([]);
  const [morePage, setMorePage] = useState<MoreId | null>(() => moneyAccess && ['reports', 'books', 'withdrawals', 'manifests'].includes(parseNavFromLocation().page) ? parseNavFromLocation().page as MoreId : null);
  /** When a page was opened from Other, Back returns there instead of More home. */
  const [moreReturnTo, setMoreReturnTo] = useState<MoreId | null>(null);
  const [booksDetail, setBooksDetail] = useState(false);
  const [booksTitle, setBooksTitle] = useState('Books');
  const [booksBack, setBooksBack] = useState<() => void>(() => () => setMorePage(null));
  const [channel, setChannel] = useState<'ebay' | 'amazon' | 'tiktok' | null>(null);
  const leaveMorePage = () => {
    if (moreReturnTo) {
      setMorePage(moreReturnTo);
      setMoreReturnTo(null);
      return;
    }
    setMorePage(null);
  };
  const [invKey, setInvKey] = useState(0);
  const scrollPos = useRef<Record<string, number>>({});
  const reportsOpenRef = useRef(onReportsOpen);
  reportsOpenRef.current = onReportsOpen;
  useEffect(() => { if (morePage === 'reports') reportsOpenRef.current?.(); }, [morePage]);

  useEffect(() => {
    document.documentElement.classList.add('app-mode', 'dark');
    document.body.classList.add('app-mode');
    return () => {
      document.documentElement.classList.remove('app-mode', 'dark');
      document.body.classList.remove('app-mode');
    };
  }, []);

  useEffect(() => {
    const onPop = () => {
      if (itemSku) { setItemSku(null); history.pushState({ floorApp: 1 }, ''); return; }
      if (channel) { setChannel(null); history.pushState({ floorApp: 1 }, ''); return; }
      if (morePage) {
        if (moreReturnTo) { setMorePage(moreReturnTo); setMoreReturnTo(null); }
        else setMorePage(null);
        history.pushState({ floorApp: 1 }, '');
      }
    };
    history.pushState({ floorApp: 1 }, '');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [itemSku, morePage, moreReturnTo, channel]);

  const deskKind = fullAccess ? 'admin' : ownerAccess ? 'owner' : 'staff';

  function switchTab(next: AppTab) {
    const allowed = phoneTabIds(deskKind);
    if (!allowed.includes(next)) next = 'inventory';
    const panel = document.querySelector('.app-tab-panel:not([hidden])') as HTMLElement | null;
    if (panel && tab) scrollPos.current[tab] = panel.scrollTop;
    setTab(next);
    setItemSku(null);
    setMorePage(null);
    setMoreReturnTo(null);
    setChannel(null);
    requestAnimationFrame(() => {
      const el = document.querySelector(`.app-tab-panel[data-tab="${next}"]`) as HTMLElement | null;
      if (el) el.scrollTop = scrollPos.current[next] || 0;
    });
  }

  const tabs = phoneTabIds(deskKind).map((id) => TABS.find((t) => t.id === id)).filter((t): t is (typeof TABS)[number] => !!t);
  const stackOpen = !!(itemSku || morePage || channel);

  return (
    <div className="app-mode-root">
      <div className="app-mode-main">
        <div className="app-tab-panel" data-tab="inventory" hidden={tab !== 'inventory' || !!itemSku}>
          {/* Keep mounted across tab switches so returning to Inventory is instant. */}
          <AppInventory
            refreshKey={invKey}
            client={client}
            storeId={storeId}
            fullAccess={fullAccess}
            staffMode={!fullAccess}
            money={money}
            stamp={stamp}
            onOpen={(sku, missingFields) => {
              setItemMissing(missingFields || []);
              history.pushState({ floorApp: 1, sku }, '');
              setItemSku(sku);
            }}
          />
        </div>

        {itemSku && (
          <AppItemDetail
            client={client}
            storeId={storeId}
            accessToken={session.access_token}
            sku={itemSku}
            missingFields={itemMissing}
            money={money}
            canDelete={fullAccess}
            staffMode={!fullAccess}
            onBack={() => setItemSku(null)}
            onChanged={() => setInvKey((n) => n + 1)}
            onSellInStore={() => {
              setItemSku(null);
              if (fullAccess) {
                switchTab('more');
                setMorePage('register');
              } else {
                switchTab('register');
              }
            }}
          />
        )}

        <div className="app-tab-panel" data-tab="receive" hidden={tab !== 'receive'}>
          {tab === 'receive' && (
            <AppReceive
              client={client}
              storeId={storeId}
              accessToken={session.access_token}
              staffMode={!fullAccess}
              onSaved={() => setInvKey((n) => n + 1)}
            />
          )}
        </div>

        <div className="app-tab-panel app-register" data-tab="register" hidden={tab !== 'register' || fullAccess}>
          {tab === 'register' && !fullAccess && (
            staffSession
              ? <RegisterPage staffSession={staffSession} variant="app" />
              : <p className="app-footer-count">This login can’t ring sales. Ask an owner to add a staff row.</p>
          )}
        </div>

        <div className="app-tab-panel" data-tab="orders" hidden={tab !== 'orders'}>
          {tab === 'orders' && (
            <AppOrders
              client={client}
              storeId={storeId}
              accessToken={session.access_token}
              money={money}
              stamp={stamp}
              isAdmin={fullAccess}
            />
          )}
        </div>

        {fullAccess && (
          <div className="app-tab-panel" data-tab="returns" hidden={tab !== 'returns'}>
            {tab === 'returns' && (
              <ReturnsPage client={client} storeId={storeId} money={money} stamp={stamp} variant="app" accessToken={session.access_token} />
            )}
          </div>
        )}

        {(fullAccess || ownerAccess) && (
          <div className="app-tab-panel" data-tab="more" hidden={tab !== 'more' || stackOpen}>
            {tab === 'more' && !morePage && !channel && (
              <AppMoreHome
                client={client}
                session={session}
                storeId={storeId}
                fullAccess={fullAccess}
                ownerAccess={ownerAccess}
                staffSession={staffSession}
                money={money}
                setPage={(p) => {
                  history.pushState({ floorApp: 1, more: p }, '');
                  setMoreReturnTo(null);
                  setMorePage(p);
                }}
                onOpenChannel={(ch) => {
                  history.pushState({ floorApp: 1, channel: ch }, '');
                  setMoreReturnTo(null);
                  setChannel(ch);
                }}
              />
            )}
          </div>
        )}

        {!fullAccess && !ownerAccess && (
          <div className="app-tab-panel" data-tab="settings" hidden={tab !== 'settings'}>
            {tab === 'settings' && (
              <AppSettingsNative
                client={client}
                fullAccess={false}
                staffSession={staffSession}
                session={session}
                settingsSlot={settingsSlot || <p className="app-footer-count">Settings unavailable.</p>}
              />
            )}
          </div>
        )}
        <div className="app-tab-panel" data-tab="locations" hidden={tab !== 'locations' || fullAccess}>
          {tab === 'locations' && !fullAccess && (
            <LocationsPage
              client={client}
              storeId={storeId}
              canManage={false}
              canAddBay
              variant="app"
              accessToken={session.access_token}
              money={money}
              onSellInStore={() => switchTab('register')}
            />
          )}
        </div>

        {fullAccess && channel && (
          <div hidden={!!itemSku}>
          <AppChannel
            channel={channel}
            accessToken={session.access_token}
            money={money}
            onOpenItem={sku => { setItemMissing([]); history.pushState({ floorApp: 1, sku }, ""); setItemSku(sku); }}
            onBack={() => {
              setChannel(null);
              // Stay on Other when the board was opened from there.
              if (moreReturnTo === 'other') setMorePage('other');
            }}
          />
          </div>
        )}

        {fullAccess && morePage === 'sales' && (
          <AppLiveSales client={client} money={money} stamp={stamp} onBack={leaveMorePage} />
        )}
        {fullAccess && morePage === 'receipts' && (
          <AppReportsNative onBack={leaveMorePage} title="Receipts">
            <ReceiptsPage client={client} money={money} stamp={stamp} variant="app" />
          </AppReportsNative>
        )}
        {fullAccess && morePage === 'other' && !channel && !itemSku && (
          <AppMoreOther
            client={client}
            session={session}
            onBack={() => { setMoreReturnTo(null); setMorePage(null); }}
            setPage={(p) => {
              history.pushState({ floorApp: 1, more: p }, '');
              setMoreReturnTo('other');
              setMorePage(p);
            }}
            onOpenChannel={(ch) => {
              history.pushState({ floorApp: 1, channel: ch }, '');
              setMoreReturnTo('other');
              setMorePage('other');
              setChannel(ch);
            }}
          />
        )}
        {fullAccess && morePage === 'connections' && (
          <AppConnections
            client={client}
            accessToken={session.access_token}
            money={money}
            stamp={stamp}
            onBack={leaveMorePage}
            backLabel={moreReturnTo === 'other' ? 'Other' : 'More'}
          />
        )}
        {moneyAccess && morePage === 'reports' && (
          <AppReportsNative onBack={leaveMorePage} action={reportsAction} onAction={onReportsAction}>
            {reportsSlot || <p className="app-footer-count">Reports unavailable.</p>}
          </AppReportsNative>
        )}
        {moneyAccess && morePage === 'withdrawals' && (
          <AppReportsNative onBack={leaveMorePage} title="Safe">
            <MoneyPage client={client} storeId={storeId} accessToken={session.access_token} money={money} stamp={stamp} />
          </AppReportsNative>
        )}
        {moneyAccess && morePage === 'books' && (
          <AppReportsNative onBack={() => booksBack()} title={booksTitle} backLabel={booksDetail ? 'Books' : (moreReturnTo === 'other' ? 'Other' : 'More')}>
            <BooksPage client={client} storeId={storeId} money={money} native onNativeNavigation={(detail, title, back) => { setBooksDetail(detail); setBooksTitle(detail ? (title || 'Books') : 'Books'); setBooksBack(() => back || leaveMorePage); }} />
          </AppReportsNative>
        )}
        {moneyAccess && morePage === 'manifests' && (
          <AppReportsNative onBack={leaveMorePage} title="Manifests" backLabel={moreReturnTo === 'other' ? 'Other' : 'More'}>
            <ManifestsPage client={client} storeId={storeId} money={money} />
          </AppReportsNative>
        )}
        {ownerAccess && morePage === 'cameras' && (
          <AppReportsNative onBack={leaveMorePage} title="Cameras">
            <section className="desk-empty"><h2>No cameras yet</h2><p>Feeds are not connected.</p></section>
          </AppReportsNative>
        )}
        {ownerAccess && morePage === 'locations' && (
          <LocationsPage
            client={client}
            storeId={storeId}
            canManage={false}
            canAddBay
            variant="app"
            onBack={leaveMorePage}
            accessToken={session.access_token}
            money={money}
            onSellInStore={() => switchTab('register')}
          />
        )}
        {fullAccess && morePage === 'locations' && (
          <LocationsPage
            client={client}
            storeId={storeId}
            canManage
            variant="app"
            onBack={leaveMorePage}
            backLabel={moreReturnTo === 'other' ? 'Other' : 'More'}
            accessToken={session.access_token}
            money={money}
            onSellInStore={() => { setMoreReturnTo(null); setMorePage('register'); }}
          />
        )}
        {fullAccess && morePage === 'insights' && (
          <AppReportsNative onBack={leaveMorePage} title="Insights" backLabel={moreReturnTo === 'other' ? 'Other' : 'More'}>
            <InsightsPage client={client} money={money} />
          </AppReportsNative>
        )}
        {fullAccess && morePage === 'dropship' && (
          <DropshipPage
            client={client}
            session={session}
            money={money}
            embed="app"
            onBack={leaveMorePage}
            backLabel={moreReturnTo === 'other' ? 'Other' : 'More'}
          />
        )}
        {fullAccess && morePage === 'depop' && (
          <AppDepopNative client={client} accessToken={session.access_token} money={money} onBack={leaveMorePage} backLabel={moreReturnTo === 'other' ? 'Other' : 'More'} />
        )}
        {fullAccess && morePage === 'register' && (
          <AppReportsNative onBack={leaveMorePage} title="Register">
            {staffSession
              ? <RegisterPage staffSession={staffSession} variant="app" />
              : <p className="app-footer-count">This login can’t ring sales. Ask an owner to add a staff row.</p>}
          </AppReportsNative>
        )}
        {(fullAccess || ownerAccess) && morePage === 'settings' && (
          <AppSettingsNative
            client={client}
            fullAccess={fullAccess}
            staffSession={staffSession}
            session={session}
            settingsSlot={settingsSlot || <p className="app-footer-count">Settings unavailable.</p>}
            onBack={leaveMorePage}
            backLabel={moreReturnTo === 'other' ? 'Other' : 'More'}
          />
        )}

      </div>

      <nav className="app-tabbar" aria-label="App">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? 'active' : ''}
            onClick={() => switchTab(t.id)}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
