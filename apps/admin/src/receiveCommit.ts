import type { SupabaseClient } from '@supabase/supabase-js';

export type ReceiveRequest = { p_request: string; p_fields: Record<string, unknown>; p_photos: string[]; p_extras: Record<string, unknown> };
export const pendingReceiveKey = (store: string) => `floor:pending-receive:${store}`;

/** Keep the same request ID after a lost response. The database commits it at most once. */
export async function commitReceive(client: SupabaseClient, store: string, request: ReceiveRequest) {
  const key = pendingReceiveKey(store);
  const existing = localStorage.getItem(key);
  if (existing) {
    const pending = JSON.parse(existing) as ReceiveRequest;
    if (pending.p_request !== request.p_request) throw new Error('Recover the interrupted save shown above before receiving another item.');
    request = pending;
  }
  // If a device cannot persist the recovery record, keep the form open instead of risking a lost receive.
  const snapshotStarted = performance.now();
  localStorage.setItem(key, JSON.stringify(request));
  const snapshotMs = performance.now() - snapshotStarted;
  const rpcStarted = performance.now();
  const { data, error } = await client.rpc('receive_commit', request);
  if (error) throw new Error(`${error.message}. Save is not confirmed; use Recover interrupted save or retry this item.`);
  localStorage.removeItem(key);
  return { ...data, client_rpc_ms: Math.round(performance.now() - rpcStarted), snapshot_ms: Math.round(snapshotMs) } as {
    skus: string[]; server_ms: number; server_steps?: Record<string, number>; replayed?: boolean; client_rpc_ms: number; snapshot_ms: number;
  };
}
