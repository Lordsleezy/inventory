import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { StaffSession } from '@floor/cloud';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ReceivePanel } from '../ReceivePanel';
import { RegisterPage } from '../RegisterPage';
import { OrdersPage } from '../OrdersPage';
import { AppInventory } from './AppInventory';
import { AppItemDetail } from './AppItemDetail';
import type { OnlineCfg, Rule, CommissionOverride } from '../payouts';

export type AppTab = 'inventory' | 'receive' | 'register' | 'orders' | 'more';

type MorePage =
  | null
  | 'sales'
  | 'ebay'
  | 'amazon'
  | 'tiktok'
  | 'depop'
  | 'marketplaces'
  | 'reports'
  | 'tax'
  | 'settings'
  | 'attention';

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
  moreContent?: (page: Exclude<MorePage, null>, back: () => void) => React.ReactNode;
};

const TABS: { id: AppTab; label: string; icon: React.ReactNode; adminOnly?: boolean }[] = [
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
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <circle cx="6" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18" cy="12" r="1.6" />
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
  rules,
  onlineCfg,
  commissionOverrides,
  personName,
  busy,
  onCommissionChanged,
  moreContent,
}: Props) {
  const [tab, setTab] = useState<AppTab>('inventory');
  const [itemSku, setItemSku] = useState<string | null>(null);
  const [morePage, setMorePage] = useState<MorePage>(null);
  const [invKey, setInvKey] = useState(0);
  const invScroll = useRef<HTMLDivElement>(null);
  const scrollPos = useRef<Record<string, number>>({});

  useEffect(() => {
    document.documentElement.classList.add('app-mode');
    document.body.classList.add('app-mode');
    return () => {
      document.documentElement.classList.remove('app-mode');
      document.body.classList.remove('app-mode');
    };
  }, []);

  // Android back: close item / more page first
  useEffect(() => {
    const onPop = () => {
      if (itemSku) {
        setItemSku(null);
        history.pushState({ floorApp: 1 }, '');
        return;
      }
      if (morePage) {
        setMorePage(null);
        history.pushState({ floorApp: 1 }, '');
      }
    };
    history.pushState({ floorApp: 1 }, '');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [itemSku, morePage]);

  function switchTab(next: AppTab) {
    const panel = document.querySelector('.app-tab-panel:not([hidden])') as HTMLElement | null;
    if (panel && tab) scrollPos.current[tab] = panel.scrollTop;
    setTab(next);
    setItemSku(null);
    setMorePage(null);
    requestAnimationFrame(() => {
      const el = document.querySelector(`.app-tab-panel[data-tab="${next}"]`) as HTMLElement | null;
      if (el) el.scrollTop = scrollPos.current[next] || 0;
    });
  }

  const tabs = TABS.filter((t) => !t.adminOnly || fullAccess);

  const moreLinks: { id: Exclude<MorePage, null>; label: string; adminOnly?: boolean }[] = [
    { id: 'attention', label: 'Needs attention' },
    { id: 'sales', label: 'Live sales', adminOnly: true },
    { id: 'ebay', label: 'eBay', adminOnly: true },
    { id: 'amazon', label: 'Amazon', adminOnly: true },
    { id: 'tiktok', label: 'TikTok', adminOnly: true },
    { id: 'depop', label: 'Depop', adminOnly: true },
    { id: 'marketplaces', label: 'Marketplaces', adminOnly: true },
    { id: 'reports', label: 'Reports', adminOnly: true },
    { id: 'tax', label: 'Tax', adminOnly: true },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div className="app-mode-root">
      <div className="app-mode-main">
        <div className="app-tab-panel" data-tab="inventory" hidden={tab !== 'inventory' || !!itemSku} ref={invScroll}>
          {tab === 'inventory' && !itemSku && (
            <AppInventory
              key={invKey}
              client={client}
              money={money}
              onOpen={(sku) => {
                history.pushState({ floorApp: 1, sku }, '');
                setItemSku(sku);
              }}
            />
          )}
        </div>

        {itemSku && (
          <AppItemDetail
            client={client}
            storeId={storeId}
            accessToken={session.access_token}
            sku={itemSku}
            money={money}
            onBack={() => setItemSku(null)}
            onChanged={() => setInvKey((n) => n + 1)}
            onSellInStore={() => {
              setItemSku(null);
              switchTab('register');
            }}
          />
        )}

        <div className="app-tab-panel app-receive" data-tab="receive" hidden={tab !== 'receive'}>
          {tab === 'receive' && (
            <>
              <div className="app-large-title"><h1>Receive</h1></div>
              <ReceivePanel
                client={client}
                storeId={storeId}
                accessToken={session.access_token}
                onSaved={() => setInvKey((n) => n + 1)}
              />
            </>
          )}
        </div>

        <div className="app-tab-panel app-register" data-tab="register" hidden={tab !== 'register'}>
          {tab === 'register' && (
            staffSession
              ? <RegisterPage staffSession={staffSession} />
              : <p className="app-footer-count">This login can’t ring sales. Ask an owner to add a staff row.</p>
          )}
        </div>

        {fullAccess && (
          <div className="app-tab-panel" data-tab="orders" hidden={tab !== 'orders'}>
            {tab === 'orders' && (
              <>
                <div className="app-large-title"><h1>Orders</h1></div>
                <div className="app-embed">
                  <OrdersPage
                    client={client}
                    accessToken={session.access_token}
                    storeId={storeId}
                    money={money}
                    stamp={stamp}
                    rules={rules}
                    cfg={onlineCfg}
                    commissionOverrides={commissionOverrides}
                    personName={personName}
                    busy={busy}
                    onCommissionChanged={onCommissionChanged}
                  />
                </div>
              </>
            )}
          </div>
        )}

        <div className="app-tab-panel" data-tab="more" hidden={tab !== 'more' || !!morePage}>
          {tab === 'more' && !morePage && (
            <>
              <div className="app-large-title"><h1>More</h1></div>
              <div className="app-group">
                {moreLinks
                  .filter((l) => !l.adminOnly || fullAccess)
                  .map((l) => (
                    <button
                      type="button"
                      className="app-more-link"
                      key={l.id}
                      onClick={() => {
                        history.pushState({ floorApp: 1, more: l.id }, '');
                        setMorePage(l.id);
                      }}
                    >
                      {l.label}
                      <span className="app-chevron">›</span>
                    </button>
                  ))}
              </div>
              <p className="app-footer-count">{staffSession?.displayName || session.user.email}</p>
              <button
                type="button"
                className="app-primary"
                style={{ background: '#1c1c1e', color: '#ff453a' }}
                onClick={() => void client.auth.signOut({ scope: 'local' })}
              >
                Sign out
              </button>
            </>
          )}
        </div>

        {morePage && (
          <div className="app-stack">
            <div className="app-nav">
              <button type="button" onClick={() => setMorePage(null)}>‹ More</button>
              <div className="app-nav-title">{moreLinks.find((l) => l.id === morePage)?.label || ''}</div>
              <button type="button" style={{ visibility: 'hidden' }}>Done</button>
            </div>
            <div className="app-embed">
              {moreContent ? moreContent(morePage, () => setMorePage(null)) : (
                <p className="app-footer-count">Open this section on desktop for the full tools.</p>
              )}
            </div>
          </div>
        )}
      </div>

      <nav className="app-tabbar" aria-label="App">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id && !itemSku && !morePage ? 'active' : tab === t.id ? 'active' : ''}
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
