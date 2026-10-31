import type { SupabaseClient } from '@supabase/supabase-js';

export type ReceiveRequest = { p_request: string; p_fields: Record<string, unknown>; p_photos: string[]; p_extras: Record<string, unknown> };
export const pendingReceiveKey = (store: string) => `floor:pending-receive:${store}`;
export const pendingReceiveRequestKey = (store: string, request: string) => `${pendingReceiveKey(store)}:${request}`;

/** The server answered with a database error: its transaction rolled back and nothing was saved. */
export class ReceiveRejectedError extends Error {
  code: string;
  constructor(message: string, code: string) { super(message); this.name = 'ReceiveRejectedError'; this.code = code; }
}

/**
 * A Postgres SQLSTATE (or PostgREST PGRST code) means the request reached the database and was refused,
 * so the receive transaction rolled back. Anything else (network drop, gateway timeout) may have committed.
 */
export function isDefiniteRejection(error: { code?: string | null } | null | undefined) {
  const code = String(error?.code || '');
  return /^[0-9A-Z]{5}$/.test(code) || /^PGRST\d+$/.test(code);
}

const friendly: Record<string, string> = {
  sku_exhausted: 'No regular SKU numbers are left to issue (sku_exhausted)',
};

/** Forget a recovery snapshot once the request is settled some other way (for example, added to existing stock). */
export function clearPendingReceive(store: string, request: string) {
  try { localStorage.removeItem(pendingReceiveRequestKey(store, request)); } catch { /* nothing to clear */ }
}

/**
 * Keep the same request ID after a lost response. The database commits it at most once.
 * A definite server rejection drops the snapshot (nothing was saved) so a corrected form is sent next time,
 * unless keepOnReject is set (Recover keeps the record so it can be retried or discarded deliberately).
 */
export async function commitReceive(client: SupabaseClient, store: string, request: ReceiveRequest, options: { keepOnReject?: boolean } = {}) {
  const legacy = pendingReceiveKey(store);
  const legacyValue = localStorage.getItem(legacy);
  if (legacyValue) {
    const saved = JSON.parse(legacyValue) as ReceiveRequest;
    localStorage.setItem(legacy + ':' + saved.p_request, legacyValue);
    localStorage.removeItem(legacy);
  }
  const key = pendingReceiveRequestKey(store, request.p_request);
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
  if (error) {
    if (isDefiniteRejection(error)) {
      if (!options.keepOnReject) localStorage.removeItem(key);
      const text = friendly[error.message] || error.message;
      throw new ReceiveRejectedError(`${text}. Nothing was saved.`, String(error.code));
    }
    throw new Error(`${error.message}. Save is not confirmed; use Recover interrupted save or retry this item.`);
  }
  localStorage.removeItem(key);
  return { ...data, client_rpc_ms: Math.round(performance.now() - rpcStarted), snapshot_ms: Math.round(snapshotMs) } as {
    skus: string[]; server_ms: number; server_steps?: Record<string, number>; replayed?: boolean; stocked?: boolean; quantity?: number; client_rpc_ms: number; snapshot_ms: number;
  };
}
