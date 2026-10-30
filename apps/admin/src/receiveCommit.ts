import type { SupabaseClient } from '@supabase/supabase-js';

export type ReceiveRequest = { p_request: string; p_fields: Record<string, unknown>; p_photos: string[]; p_extras: Record<string, unknown> };
export const pendingReceiveKey = (store: string) => `floor:pending-receive:${store}`;

/** Keep the same request ID after a lost response. The database commits it at most once. */
export async function commitReceive(client: SupabaseClient, store: string, request: ReceiveRequest) {
  const legacy = pendingReceiveKey(store);
  const legacyValue = localStorage.getItem(legacy);
  if (legacyValue) {
    const saved = JSON.parse(legacyValue) as ReceiveRequest;
    localStorage.setItem(legacy + ':' + saved.p_request, legacyValue);
    localStorage.removeItem(legacy);
  }
  const key = legacy + ':' + request.p_request;
  const existing = localStorage.getItem(key);
  if (existing) {
    const pending = JSON.parse(existing) as ReceiveRequest;
    request = pending;
  }
  // If a device cannot persist the recovery record, keep the form open instead of risking a lost receive.
  const snapshotStarted = performance.now();
  localStorage.setItem(key, JSON.stringify(request));
  const snapshotMs = performance.now() - snapshotStarted;
  const rpcStarted = performance.now();
  const { data, error } = await client.rpc('portal_receive_stocked_commit', request);
  if (error) throw new Error(`${error.message}. Save is not confirmed; use Recover interrupted save or retry this item.`);
  localStorage.removeItem(key);
  return { ...data, client_rpc_ms: Math.round(performance.now() - rpcStarted), snapshot_ms: Math.round(snapshotMs) } as {
    skus: string[]; server_ms: number; server_steps?: Record<string, number>; replayed?: boolean; stocked?: boolean; quantity?: number; client_rpc_ms: number; snapshot_ms: number;
  };
}
