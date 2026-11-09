import type { MainPage } from './navigation';

export type DeskLink = {
  page: MainPage;
  label: string;
  hint: string;
  inventoryTab?: 'in-stock' | 'receive' | 'lookup-test' | 'merge-duplicates' | 'fix-titles';
  reportTab?: 'profit' | 'shipping' | 'expenses' | 'payouts' | 'returns' | 'replacements' | 'sales-tax';
};

export type DeskGroup = { label: string; links: DeskLink[] };

/** Desktop sidebar and Home grid. Nothing removed; Other is gone because its items live here. */
export const DESK_GROUPS: DeskGroup[] = [
  {
    label: 'Sell',
    links: [
      { page: 'register', label: 'Register', hint: 'Point of sale' },
      { page: 'sales', label: 'Live Sales', hint: 'Today’s tickets' },
      { page: 'orders', label: 'Orders', hint: 'Ship & track' },
      { page: 'returns', label: 'Returns', hint: 'Open & closed' },
      { page: 'receipts', label: 'Receipts', hint: 'Sold & reprints' },
    ],
  },
  {
    label: 'Stock',
    links: [
      { page: 'inventory', label: 'Inventory', hint: 'Units on hand' },
      { page: 'manifests', label: 'Manifests', hint: 'Inbound lots' },
      { page: 'locations', label: 'Locations', hint: 'Bays & bins' },
    ],
  },
  {
    label: 'Money',
    links: [
      { page: 'reports', label: 'Reports', hint: 'Profit, fees, tax' },
      { page: 'books', label: 'Books', hint: 'Month close' },
      { page: 'withdrawals', label: 'Safe', hint: 'Cash accounts' },
    ],
  },
  {
    label: 'Channels',
    links: [
      { page: 'ebay', label: 'eBay', hint: 'Listed & sold' },
      { page: 'depop', label: 'Depop', hint: 'Listed & manual' },
      { page: 'amazon', label: 'Amazon', hint: 'Listed & catalog' },
      { page: 'tiktok', label: 'TikTok', hint: 'Listed & sold' },
      { page: 'dropship', label: 'Dropship', hint: 'Suppliers' },
      { page: 'marketplaces', label: 'Connections', hint: 'Sync & login' },
    ],
  },
  {
    label: 'System',
    links: [
      { page: 'insights', label: 'Insights', hint: 'Category pace' },
      { page: 'cameras', label: 'Cameras', hint: 'Store feeds' },
      { page: 'logs', label: 'Logs', hint: 'Jobs & errors' },
      { page: 'settings', label: 'Settings', hint: 'People & split' },
    ],
  },
];

export const HOME_INVENTORY_LINKS: DeskLink[] = [
  { page: 'inventory', label: 'In stock', hint: '', inventoryTab: 'in-stock' },
  { page: 'inventory', label: 'Receive', hint: '', inventoryTab: 'receive' },
  { page: 'inventory', label: 'Merge duplicates', hint: '', inventoryTab: 'merge-duplicates' },
  { page: 'inventory', label: 'Fix titles', hint: '', inventoryTab: 'fix-titles' },
  { page: 'inventory', label: 'Lookup test', hint: '', inventoryTab: 'lookup-test' },
];

export const HOME_REPORT_LINKS: DeskLink[] = [
  { page: 'reports', label: 'Profit', hint: '', reportTab: 'profit' },
  { page: 'reports', label: 'Fees', hint: '', reportTab: 'shipping' },
  { page: 'reports', label: 'Expenses', hint: '', reportTab: 'expenses' },
  { page: 'reports', label: 'Payouts', hint: '', reportTab: 'payouts' },
  { page: 'reports', label: 'Sales tax', hint: '', reportTab: 'sales-tax' },
];

export const ASSOCIATE_LINKS: DeskLink[] = [
  { page: 'register', label: 'Register', hint: 'Point of sale' },
  { page: 'inventory', label: 'Inventory', hint: 'Units on hand', inventoryTab: 'in-stock' },
  { page: 'inventory', label: 'Receive', hint: 'Add a unit', inventoryTab: 'receive' },
  { page: 'orders', label: 'Orders', hint: 'Ship & track' },
  { page: 'locations', label: 'Locations', hint: 'Bays & bins' },
  { page: 'settings', label: 'Settings', hint: 'Your account' },
];

/** Owner (Steve): same floor desk as staff, plus money/stock extras. */
export const OWNER_EXTRA_LINKS: DeskLink[] = [
  { page: 'reports', label: 'Reports', hint: 'Profit, fees, tax' },
  { page: 'withdrawals', label: 'Safe', hint: 'Cash accounts' },
  { page: 'manifests', label: 'Manifests', hint: 'Inbound lots' },
  { page: 'books', label: 'Books', hint: 'Month close' },
];

export const OWNER_LINKS: DeskLink[] = [...ASSOCIATE_LINKS, ...OWNER_EXTRA_LINKS];

export type DeskAccess = 'admin' | 'owner' | 'staff';

/** Owner role wins over portal_admins so Steve does not get the full admin channel dump. */
export function resolveDeskAccess(staffRole: string | null | undefined, portalAdmin: boolean): DeskAccess {
  if (staffRole === 'owner') return 'owner';
  if (staffRole === 'manager' || portalAdmin) return 'admin';
  return 'staff';
}

export function deskNavGroups(access: DeskAccess): DeskGroup[] {
  if (access === 'admin') return DESK_GROUPS;
  if (access === 'owner') return [{ label: 'Your desk', links: OWNER_LINKS }];
  return [{ label: 'Your desk', links: ASSOCIATE_LINKS }];
}

export function deskAllowedPages(access: DeskAccess): MainPage[] | null {
  if (access === 'admin') return null;
  if (access === 'owner') {
    return ['home', 'register', 'inventory', 'orders', 'locations', 'settings', 'reports', 'withdrawals', 'manifests', 'books'];
  }
  return ['home', 'register', 'inventory', 'orders', 'locations', 'settings'];
}

export function deskRoleLabel(access: DeskAccess): string {
  if (access === 'admin') return 'Admin';
  if (access === 'owner') return 'Owner';
  return 'Staff';
}
