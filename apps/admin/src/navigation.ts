export type MainPage =
  | 'register'
  | 'sales'
  | 'orders'
  | 'receipts'
  | 'inventory'
  | 'online'
  | 'marketplaces'
  | 'ebay'
  | 'amazon'
  | 'tiktok'
  | 'depop'
  | 'reports'
  | 'withdrawals'
  | 'manifests'
  | 'locations'
  | 'insights'
  | 'cameras'
  | 'remote'
  | 'logs'
  | 'settings';
export type ReportTab = 'profit' | 'shipping' | 'expenses' | 'overhead' | 'payouts' | 'daily' | 'sales-tax' | 'returns';
/** In stock / Sold / Unfinished / Defective are unit lists; the rest are tools. Unfinished replaces the old Needs attention tab. */
export type InventoryTab = 'in-stock' | 'sold' | 'unfinished' | 'defective' | 'missing-category' | 'receive' | 'lookup-test' | 'products' | 'measure-mat';
export type AttentionSection =
  | 'all'
  | 'missing-cost'
  | 'missing-brand'
  | 'missing-category'
  | 'missing-specifics'
  | 'missing-spec'
  | 'missing-upc'
  | 'missing-photo'
  | 'missing-price'
  | 'missing-condition'
  | 'missing-model'
  | 'missing-description';
export type OnlineTab = 'listed' | 'ready' | 'not-ready' | 'msc' | 'reports' | 'sold';
/** Listing subtabs: eBay, Depop, Amazon, TikTok (+ Facebook-only oversized). Sale history may still show Mercari/Whatnot. */
export type OnlineChannel = 'all' | 'ebay' | 'depop' | 'amazon' | 'tiktok' | 'facebook';

const LEGACY: Record<string, { page: MainPage; tab?: ReportTab; inventoryTab?: InventoryTab; section?: AttentionSection; onlineTab?: OnlineTab; onlineChannel?: OnlineChannel }> = {
  eligibility: { page: 'settings' },
  online: { page: 'online' },
  expenses: { page: 'reports', tab: 'expenses' },
  taxes: { page: 'reports', tab: 'sales-tax' },
  tax: { page: 'reports', tab: 'sales-tax' },
  channels: { page: 'reports', tab: 'profit' },
  costs: { page: 'inventory', inventoryTab: 'unfinished', section: 'missing-cost' },
  reviews: { page: 'inventory', inventoryTab: 'unfinished', section: 'missing-cost' },
  payouts: { page: 'reports', tab: 'payouts' },
  withdrawals: { page: 'withdrawals' },
  manifests: { page: 'manifests' },
  locations: { page: 'locations' },
  projections: { page: 'insights' },
  insights: { page: 'insights' },
  settings: { page: 'settings' },
  marketplaces: { page: 'marketplaces' },
  ebay: { page: 'ebay' },
  amazon: { page: 'amazon' },
  tiktok: { page: 'tiktok' },
  depop: { page: 'depop' },
  cameras: { page: 'cameras' },
  remote: { page: 'remote' },
  logs: { page: 'logs' },
  sales: { page: 'sales' },
  orders: { page: 'orders' },
  receipts: { page: 'receipts' },
  register: { page: 'register' },
  inventory: { page: 'inventory' },
  reports: { page: 'reports' },
  'your-call': { page: 'inventory', inventoryTab: 'unfinished', section: 'missing-cost' },
  review: { page: 'inventory', inventoryTab: 'unfinished', section: 'missing-cost' },
  'missing-other': { page: 'inventory', inventoryTab: 'unfinished', section: 'missing-cost' },
};

const MAIN: MainPage[] = [
  'register',
  'sales',
  'orders',
  'receipts',
  'inventory',
  'online',
  'marketplaces',
  'ebay',
  'amazon',
  'tiktok',
  'depop',
  'reports',
  'withdrawals',
  'manifests',
  'locations',
  'insights',
  'cameras',
  'remote',
  'logs',
  'settings',
];
const SECTIONS: AttentionSection[] = [
  'all',
  'missing-cost',
  'missing-brand',
  'missing-category',
  'missing-specifics',
  'missing-spec',
  'missing-upc',
  'missing-photo',
  'missing-price',
  'missing-condition',
  'missing-model',
  'missing-description',
];
const ONLINE_TABS: OnlineTab[] = ['listed', 'ready', 'not-ready', 'msc', 'reports', 'sold'];
const ONLINE_CHANNELS: OnlineChannel[] = ['all', 'ebay', 'depop', 'amazon', 'tiktok', 'facebook'];
const ONLINE_CHANNELS_SET = new Set<string>(ONLINE_CHANNELS);
/** Retired list targets — old bookmarks fall back to all. */
const RETIRED_ONLINE_CHANNELS = new Set(['mercari', 'vendoo', 'whatnot']);

export type NavState = {
  page: MainPage;
  reportTab: ReportTab;
  inventoryTab: InventoryTab;
  attentionSection: AttentionSection;
  onlineTab: OnlineTab;
  onlineChannel: OnlineChannel;
};

export function defaultNavState(page: MainPage = 'sales'): NavState {
  return {
    page,
    reportTab: 'profit',
    inventoryTab: 'in-stock',
    attentionSection: 'all',
    onlineTab: 'listed',
    onlineChannel: 'all',
  };
}

export function parseNavFromLocation(): NavState {
  const q = new URLSearchParams(window.location.search);
  const hashRaw = window.location.hash.replace(/^#/, '').trim();
  const hashQ = hashRaw.includes('=') ? new URLSearchParams(hashRaw.replace(/^\?/, '')) : null;
  const hashPage = hashRaw && !hashRaw.includes('=') ? hashRaw.split('/')[0] : '';
  const raw = (q.get('page') || hashQ?.get('page') || hashPage || 'sales').toLowerCase();
  if (q.get('ebay') === '1') return { ...defaultNavState(), page: 'ebay' };
  const mapped = LEGACY[raw];
  const base = mapped ? mapped.page : MAIN.includes(raw as MainPage) ? (raw as MainPage) : 'sales';
  const tabRaw = q.get('tab') || hashQ?.get('tab') || mapped?.tab || 'profit';
  const invTabRaw =
    q.get('inventoryTab') || q.get('inv') || hashQ?.get('inventoryTab') || hashQ?.get('inv') || mapped?.inventoryTab || 'in-stock';
  let sectionRaw =
    q.get('section') || q.get('attention') || hashQ?.get('section') || hashQ?.get('attention') || mapped?.section || 'all';
  // Old bookmarks for removed queues → Missing cost
  if (sectionRaw === 'your-call' || sectionRaw === 'reviews' || sectionRaw === 'missing-other') {
    sectionRaw = 'missing-cost';
  }
  let onlineTabRaw = q.get('onlineTab') || hashQ?.get('onlineTab') || mapped?.onlineTab || 'listed';
  const rawOnlineTab = onlineTabRaw;
  const forceFacebookOnly = rawOnlineTab === 'facebook-only' || rawOnlineTab === 'not-listable';
  if (forceFacebookOnly) onlineTabRaw = 'listed';
  // Allow ?onlineTab=ebay (channel-as-tab bookmarks)
  let onlineChannelRaw = q.get('channel') || hashQ?.get('channel') || mapped?.onlineChannel || (forceFacebookOnly ? 'facebook' : 'all');
  if (forceFacebookOnly) onlineChannelRaw = 'facebook';
  if (ONLINE_CHANNELS_SET.has(onlineTabRaw)) {
    onlineChannelRaw = onlineTabRaw;
    onlineTabRaw = 'listed';
  }
  if (RETIRED_ONLINE_CHANNELS.has(onlineChannelRaw) || RETIRED_ONLINE_CHANNELS.has(onlineTabRaw)) {
    onlineChannelRaw = 'all';
  }
  const reportTabs: ReportTab[] = ['profit', 'shipping', 'expenses', 'overhead', 'payouts', 'daily', 'sales-tax', 'returns'];
  const invTabs: InventoryTab[] = ['in-stock', 'sold', 'unfinished', 'defective', 'missing-category', 'receive', 'lookup-test', 'products', 'measure-mat'];
  // Old bookmarks: Browse → In stock, Needs attention → Unfinished.
  const invTab = invTabRaw === 'browse' ? 'in-stock' : invTabRaw === 'attention' ? 'unfinished' : invTabRaw;
  return {
    page: base,
    reportTab: reportTabs.includes(tabRaw as ReportTab) ? (tabRaw as ReportTab) : 'profit',
    inventoryTab: invTabs.includes(invTab as InventoryTab) ? (invTab as InventoryTab) : 'in-stock',
    attentionSection: SECTIONS.includes(sectionRaw as AttentionSection)
      ? (sectionRaw as AttentionSection)
      : 'all',
    onlineTab: ONLINE_TABS.includes(onlineTabRaw as OnlineTab) ? (onlineTabRaw as OnlineTab) : 'listed',
    onlineChannel: ONLINE_CHANNELS.includes(onlineChannelRaw as OnlineChannel)
      ? (onlineChannelRaw as OnlineChannel)
      : 'all',
  };
}

export function writeNavToLocation(state: NavState) {
  const q = new URLSearchParams();
  q.set('page', state.page);
  if (state.page === 'reports' && state.reportTab !== 'profit') q.set('tab', state.reportTab); // includes returns
  if (state.page === 'inventory') {
    if (state.inventoryTab !== 'in-stock') q.set('inventoryTab', state.inventoryTab);
    if (state.inventoryTab === 'unfinished' && state.attentionSection !== 'all') {
      q.set('section', state.attentionSection);
    }
  }
  if (state.page === 'online') {
    if (state.onlineTab !== 'listed') q.set('onlineTab', state.onlineTab);
    if (state.onlineTab === 'listed' && state.onlineChannel !== 'all') q.set('channel', state.onlineChannel);
  }
  const next = `${window.location.pathname}?${q.toString()}${window.location.hash.replace(/^#\/[^?]*/, '')}`;
  const cur = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== cur) window.history.replaceState(null, '', next);
}
