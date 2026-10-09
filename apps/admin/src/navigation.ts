export type MainPage = 'sales' | 'orders' | 'inventory' | 'marketplaces' | 'reports' | 'cameras' | 'logs' | 'settings';
export type ReportTab = 'profit' | 'shipping' | 'expenses' | 'payouts';
export type InventoryTab = 'browse' | 'receive' | 'attention';
export type AttentionSection = 'your-call' | 'missing-cost' | 'reviews';

const LEGACY: Record<string, { page: MainPage; tab?: ReportTab; inventoryTab?: InventoryTab; section?: AttentionSection }> = {
  eligibility: { page: 'settings' },
  online: { page: 'settings' },
  expenses: { page: 'reports', tab: 'expenses' },
  taxes: { page: 'reports', tab: 'shipping' },
  channels: { page: 'reports', tab: 'profit' },
  costs: { page: 'inventory', inventoryTab: 'attention', section: 'missing-cost' },
  reviews: { page: 'inventory', inventoryTab: 'attention', section: 'reviews' },
  payouts: { page: 'reports', tab: 'payouts' },
  settings: { page: 'settings' },
  marketplaces: { page: 'marketplaces' },
  cameras: { page: 'cameras' },
  logs: { page: 'logs' },
  sales: { page: 'sales' },
  orders: { page: 'orders' },
  inventory: { page: 'inventory' },
  reports: { page: 'reports' },
  'your-call': { page: 'inventory', inventoryTab: 'attention', section: 'your-call' },
  review: { page: 'inventory', inventoryTab: 'attention', section: 'your-call' },
};

const MAIN: MainPage[] = ['sales', 'orders', 'inventory', 'marketplaces', 'reports', 'cameras', 'logs', 'settings'];

export type NavState = {
  page: MainPage;
  reportTab: ReportTab;
  inventoryTab: InventoryTab;
  attentionSection: AttentionSection;
};

export function defaultNavState(): NavState {
  return { page: 'sales', reportTab: 'profit', inventoryTab: 'browse', attentionSection: 'your-call' };
}

export function parseNavFromLocation(): NavState {
  const q = new URLSearchParams(window.location.search);
  const hashRaw = window.location.hash.replace(/^#/, '').trim();
  const hashQ = hashRaw.includes('=') ? new URLSearchParams(hashRaw.replace(/^\?/, '')) : null;
  const hashPage = hashRaw && !hashRaw.includes('=') ? hashRaw.split('/')[0] : '';
  const raw = (q.get('page') || hashQ?.get('page') || hashPage || 'sales').toLowerCase();
  if (q.get('ebay') === '1') return { ...defaultNavState(), page: 'marketplaces' };
  const mapped = LEGACY[raw];
  const base = mapped ? mapped.page : (MAIN.includes(raw as MainPage) ? (raw as MainPage) : 'sales');
  const tabRaw = q.get('tab') || hashQ?.get('tab') || mapped?.tab || 'profit';
  const invTabRaw = q.get('inventoryTab') || q.get('inv') || hashQ?.get('inventoryTab') || hashQ?.get('inv') || mapped?.inventoryTab || 'browse';
  const sectionRaw = q.get('section') || q.get('attention') || hashQ?.get('section') || hashQ?.get('attention') || mapped?.section || 'your-call';
  const reportTabs: ReportTab[] = ['profit', 'shipping', 'expenses', 'payouts'];
  const invTabs: InventoryTab[] = ['browse', 'receive', 'attention'];
  const sections: AttentionSection[] = ['your-call', 'missing-cost', 'reviews'];
  return {
    page: base,
    reportTab: reportTabs.includes(tabRaw as ReportTab) ? (tabRaw as ReportTab) : 'profit',
    inventoryTab: invTabs.includes(invTabRaw as InventoryTab) ? (invTabRaw as InventoryTab) : 'browse',
    attentionSection: sections.includes(sectionRaw as AttentionSection) ? (sectionRaw as AttentionSection) : 'your-call',
  };
}

export function writeNavToLocation(state: NavState) {
  const q = new URLSearchParams();
  q.set('page', state.page);
  if (state.page === 'reports' && state.reportTab !== 'profit') q.set('tab', state.reportTab);
  if (state.page === 'inventory') {
    if (state.inventoryTab !== 'browse') q.set('inventoryTab', state.inventoryTab);
    if (state.inventoryTab === 'attention' && state.attentionSection !== 'your-call') q.set('section', state.attentionSection);
  }
  const next = `${window.location.pathname}?${q.toString()}${window.location.hash.replace(/^#\/[^?]*/, '')}`;
  const cur = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== cur) window.history.replaceState(null, '', next);
}
