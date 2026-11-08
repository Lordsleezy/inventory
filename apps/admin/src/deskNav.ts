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
  { page: 'inventory', label: 'Inventory', hint: 'Units on hand' },
  { page: 'orders', label: 'Orders', hint: 'Ship & track' },
  { page: 'locations', label: 'Locations', hint: 'Bays & bins' },
  { page: 'settings', label: 'Settings', hint: 'Your account' },
];
