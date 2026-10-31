import type { SupabaseClient } from '@supabase/supabase-js';

export type LocationAllocation = { location_code: string; quantity: number };

export function assignedTotal(allocations: LocationAllocation[]) {
  return allocations.reduce((sum, row) => sum + row.quantity, 0);
}

export function unassignedQty(onHand: number, allocations: LocationAllocation[]) {
  return Math.max(0, onHand - assignedTotal(allocations));
}

export function formatLocationSummary(onHand: number, allocations: LocationAllocation[]) {
  const parts = allocations.map((row) => `${row.quantity} at ${row.location_code}`);
  const loose = unassignedQty(onHand, allocations);
  if (loose > 0) parts.push(`${loose} unassigned`);
  return parts.length ? parts.join(' · ') : 'Unassigned';
}

export function singleBinOrUnassigned(allocations: LocationAllocation[], onHand: number) {
  if (allocations.length === 0) return true;
  if (allocations.length > 1) return false;
  return unassignedQty(onHand, allocations) <= 0;
}

export async function rpcMoveLocationStock(
  client: SupabaseClient,
  sku: string,
  quantity: number,
  from: string | null,
  to: string | null,
) {
  const { error } = await client.rpc('portal_move_location_stock', {
    p_sku: sku,
    p_to: to ?? '',
    p_quantity: quantity,
    p_from: from,
  });
  if (error) throw error;
}

/** Apply a simple editor location change (single bin or all-unassigned). */
export async function applySimpleLocationChange(
  client: SupabaseClient,
  sku: string,
  onHand: number,
  allocations: LocationAllocation[],
  target: string,
) {
  const loose = unassignedQty(onHand, allocations);
  const only = allocations.length === 1 ? allocations[0] : null;
  const current = only?.location_code || '';
  if (target === current && loose <= 0) return;
  if (!target) {
    if (!only) throw new Error('Nothing is assigned to a bin yet.');
    await rpcMoveLocationStock(client, sku, only.quantity, only.location_code, null);
    return;
  }
  if (only && loose <= 0) {
    if (target === only.location_code) return;
    await rpcMoveLocationStock(client, sku, only.quantity, only.location_code, target);
    return;
  }
  const qty = loose > 0 ? loose : onHand;
  await rpcMoveLocationStock(client, sku, qty, null, target);
}

/** Partial move between bins / unassigned pool. */
export async function applyPartialLocationMove(
  client: SupabaseClient,
  sku: string,
  quantity: number,
  from: string,
  to: string,
  allocations: LocationAllocation[],
  onHand: number,
) {
  const fromCode = from === '__unassigned__' ? null : from;
  const toCode = to === '__unassigned__' ? null : to;
  if (!fromCode && !toCode) throw new Error('Choose a destination location.');
  if (fromCode === toCode) return;
  if (fromCode) {
    const at = allocations.find((row) => row.location_code === fromCode)?.quantity || 0;
    if (quantity > at) throw new Error('Quantity exceeds stock at the source location.');
  } else {
    const loose = unassignedQty(onHand, allocations);
    if (quantity > loose) throw new Error('Quantity exceeds unassigned stock.');
  }
  await rpcMoveLocationStock(client, sku, quantity, fromCode, toCode);
}
