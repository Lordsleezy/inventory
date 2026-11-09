import type { ReceivedItem } from './types';

export function manifestedItemCount(manifests: { item_count?: unknown }[] | undefined) {
  return (manifests || []).reduce((sum, row) => sum + (Number(row.item_count) || 0), 0);
}

function receivedQty(item: ReceivedItem) {
  return Math.max(1, Number(item.qty_on_hand || 1));
}

/** A listing string is either "ebay listed, depop ended" or the unit state when nothing is listed. */
export function listedChannels(listing: string) {
  const channels: string[] = [];
  for (const part of String(listing || '').split(',')) {
    const bits = part.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (bits.length < 2 || bits[bits.length - 1] !== 'listed') continue;
    const channel = bits.slice(0, -1).join(' ');
    if (channel && !channels.includes(channel)) channels.push(channel);
  }
  return channels;
}

export function receivedInventoryCounts(items: ReceivedItem[]) {
  let units = 0;
  let costCents = 0;
  let online = 0;
  let notListed = 0;
  let defective = 0;
  let missingCost = 0;
  const channels = new Map<string, number>();
  const conditions = new Map<string, number>();
  const categories = new Map<string, { units: number; cost_cents: number }>();
  for (const item of items) {
    const qty = receivedQty(item);
    const cost = Number(item.cost_cents || 0) * qty;
    units += qty;
    costCents += cost;
    const state = String(item.unit_state || '').toLowerCase();
    const listing = String(item.listing_status || '');
    const isDefective = state === 'defective' || listing.trim().toLowerCase() === 'defective';
    const listed = listedChannels(listing);
    if (isDefective) defective += qty;
    else if (listed.length) online += qty;
    else notListed += qty;
    if (!Number(item.cost_cents)) missingCost += qty;
    for (const channel of listed) channels.set(channel, (channels.get(channel) || 0) + qty);
    const condition = String(item.condition || 'Not set');
    conditions.set(condition, (conditions.get(condition) || 0) + qty);
    const category = String(item.category || 'Uncategorized');
    const bucket = categories.get(category) || { units: 0, cost_cents: 0 };
    bucket.units += qty;
    bucket.cost_cents += cost;
    categories.set(category, bucket);
  }
  const byCount = (a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0]);
  return {
    skus: items.length,
    units,
    cost_cents: costCents,
    online_units: online,
    not_listed_units: notListed,
    defective_units: defective,
    missing_cost_units: missingCost,
    channels: [...channels.entries()].sort(byCount).map(([channel, count]) => ({ channel, units: count })),
    conditions: [...conditions.entries()].sort(byCount).map(([condition, count]) => ({ condition, units: count })),
    categories: [...categories.entries()]
      .sort((a, b) => b[1].units - a[1].units || a[0].localeCompare(b[0]))
      .map(([category, bucket]) => ({ category, ...bucket })),
  };
}

/** Spreadsheet rows. Counts only, with manifested directly under items inventoried. */
export function receivedSheetMetrics(items: ReceivedItem[], manifested: number) {
  const counts = receivedInventoryCounts(items);
  return [
    { label: 'Items inventoried', count: counts.skus, cents: counts.cost_cents },
    { label: 'Manifested', count: manifested, cents: null },
    { label: 'Units', count: counts.units, cents: null },
    { label: 'Listed online', count: counts.online_units, cents: null },
    { label: 'Not listed', count: counts.not_listed_units, cents: null },
    { label: 'Defective', count: counts.defective_units, cents: null },
    { label: 'Missing a cost', count: counts.missing_cost_units, cents: null },
  ];
}
