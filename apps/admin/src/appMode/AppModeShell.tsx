import { useEffect, useRef, useState } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { StaffSession } from '@floor/cloud';
import { RegisterPage } from '../RegisterPage';
import { AppInventory } from './AppInventory';
import { AppItemDetail } from './AppItemDetail';
import { AppReceive } from './AppReceive';
import { AppOrders } from './AppOrders';
import { AppChannel } from './AppChannel';
import {
  AppMoreHome,
  AppAttention,
  AppLiveSales,
  AppConnections,
  AppReportsNative,
  AppTaxNative,
  AppDepopNative,
  AppSettingsNative,
  type MoreId,
} from './AppMore';
import type { OnlineCfg, Rule, CommissionOverride } from '../payouts';

export type AppTab = 'inventory' | 'receive' | 'register' | 'orders' | 'more' | 'settings';

type Props = {
  client: SupabaseClient;
  session: Session;
  storeId: string;
  fullAccess: boolean;
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
};

/** Store associates (e.g. Jacob): Inventory / Receive / Register / Settings. */
const ASSOCIATE_TABS: AppTab[] = ['inventory', 'receive', 'register', 'settings'];

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
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="8" /><path d="M12 7v10M9.5 9.5c.8-1 4.2-1 5 1s-1.5 2.5-2.5 2.5 3 1 2.5 3-3.5 1.2-4.5.2" />
      </svg>
    ),
  },
  {
    id: 'orders',
    label: 'Orders',
    adminOnly: true,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M7 7h10M7 12h10M7 17h6" /><path d="M4 4h16v16H4z" />
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
];

export function AppModeShell({
  client,
  session,
  storeId,
  fullAccess,
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
}: Props) {
  void _rules;
  void _onlineCfg;
  void _commissionOverrides;
  void _personName;
  void _busy;
  void _onCommissionChanged;
  const [tab, setTab] = useState<AppTab>('inventory');
  const [itemSku, setItemSku] = useState<string | null>(null);
  const [morePage, setMorePage] = useState<MoreId | null>(null);
  const [channel, setChannel] = useState<'ebay' | 'amazon' | 'tiktok' | null>(null);
  const [invKey, setInvKey] = useState(0);
  const scrollPos = useRef<Record<string, number>>({});

  useEffect(() => {
    document.documentElement.classList.add('app-mode');
    document.body.classList.add('app-mode');
    return () => {
      document.documentElement.classList.remove('app-mode');
      document.body.classList.remove('app-mode');
    };
  }, []);

  useEffect(() => {
    const onPop = () => {
      if (itemSku) { setItemSku(null); history.pushState({ floorApp: 1 }, ''); return; }
      if (channel) { setChannel(null); history.pushState({ floorApp: 1 }, ''); return; }
      if (morePage) { setMorePage(null); history.pushState({ floorApp: 1 }, ''); }
    };
    history.pushState({ floorApp: 1 }, '');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [itemSku, morePage, channel]);

  function switchTab(next: AppTab) {
    if (!fullAccess && !ASSOCIATE_TABS.includes(next)) next = 'inventory';
    const panel = document.querySelector('.app-tab-panel:not([hidden])') as HTMLElement | null;
    if (panel && tab) scrollPos.current[tab] = panel.scrollTop;
    setTab(next);
    setItemSku(null);
    setMorePage(null);
    setChannel(null);
    requestAnimationFrame(() => {
      const el = document.querySelector(`.app-tab-panel[data-tab="${next}"]`) as HTMLElement | null;
      if (el) el.scrollTop = scrollPos.current[next] || 0;
    });
  }

  // Associates: Inventory / Receive / Register / Settings. Admins also get Orders + More.
  const tabs = TABS.filter((t) => {
    if (t.adminOnly && !fullAccess) return false;
    if (t.associateOnly && fullAccess) return false;
    return true;
  });
  const stackOpen = !!(itemSku || morePage || channel);

  return (
    <div className="app-mode-root">
      <div className="app-mode-main">
        <div className="app-tab-panel" data-tab="inventory" hidden={tab !== 'inventory' || !!itemSku}>
          {/* Keep mounted across tab switches so returning to Inventory is instant. */}
          <AppInventory
            key={invKey}
            client={client}
            money={money}
            onOpen={(sku) => {
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
            money={money}
            canDelete={fullAccess}
            onBack={() => setItemSku(null)}
            onChanged={() => setInvKey((n) => n + 1)}
            onSellInStore={() => {
              setItemSku(null);
              switchTab('register');
            }}
          />
        )}

        <div className="app-tab-panel" data-tab="receive" hidden={tab !== 'receive'}>
          {tab === 'receive' && (
            <AppReceive
              client={client}
              storeId={storeId}
              accessToken={session.access_token}
              onSaved={() => setInvKey((n) => n + 1)}
            />
          )}
        </div>

        <div className="app-tab-panel app-register" data-tab="register" hidden={tab !== 'register'}>
          {tab === 'register' && (
            staffSession
              ? <RegisterPage staffSession={staffSession} variant="app" />
              : <p className="app-footer-count">This login can’t ring sales. Ask an owner to add a staff row.</p>
          )}
        </div>

        {fullAccess && (
          <div className="app-tab-panel" data-tab="orders" hidden={tab !== 'orders'}>
            {tab === 'orders' && (
              <AppOrders
                client={client}
                storeId={storeId}
                accessToken={session.access_token}
                money={money}
                stamp={stamp}
              />
            )}
          </div>
        )}

        {fullAccess && (
          <div className="app-tab-panel" data-tab="more" hidden={tab !== 'more' || stackOpen}>
            {tab === 'more' && !morePage && !channel && (
              <AppMoreHome
                client={client}
                session={session}
                fullAccess={fullAccess}
                staffSession={staffSession}
                money={money}
                setPage={(p) => {
                  history.pushState({ floorApp: 1, more: p }, '');
                  setMorePage(p);
                }}
                onOpenChannel={(ch) => {
                  history.pushState({ floorApp: 1, channel: ch }, '');
                  setChannel(ch);
                }}
              />
            )}
          </div>
        )}

        {!fullAccess && (
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

        {fullAccess && channel && (
          <AppChannel
            channel={channel}
            accessToken={session.access_token}
            money={money}
            onBack={() => setChannel(null)}
          />
        )}

        {fullAccess && morePage === 'attention' && (
          <AppAttention
            client={client}
            storeId={storeId}
            money={money}
            stamp={stamp}
            onBack={() => setMorePage(null)}
          />
        )}
        {fullAccess && morePage === 'sales' && (
          <AppLiveSales client={client} money={money} stamp={stamp} onBack={() => setMorePage(null)} />
        )}
        {fullAccess && morePage === 'connections' && (
          <AppConnections
            client={client}
            accessToken={session.access_token}
            money={money}
            stamp={stamp}
            onBack={() => setMorePage(null)}
          />
        )}
        {fullAccess && morePage === 'reports' && (
          <AppReportsNative onBack={() => setMorePage(null)}>
            {reportsSlot || <p className="app-footer-count">Reports unavailable.</p>}
          </AppReportsNative>
        )}
        {fullAccess && morePage === 'tax' && (
          <AppTaxNative client={client} money={money} stamp={stamp} onBack={() => setMorePage(null)} />
        )}
        {fullAccess && morePage === 'depop' && (
          <AppDepopNative accessToken={session.access_token} money={money} onBack={() => setMorePage(null)} />
        )}
        {fullAccess && morePage === 'settings' && (
          <AppSettingsNative
            client={client}
            fullAccess={fullAccess}
            staffSession={staffSession}
            session={session}
            settingsSlot={settingsSlot || <p className="app-footer-count">Settings unavailable.</p>}
            onBack={() => setMorePage(null)}
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
