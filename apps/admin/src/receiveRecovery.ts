import type { ReceiveRequest } from './receiveCommit';

export type RecoveryRecord = { key: string; request: ReceiveRequest | null };
/** Treat old/malformed drafts as optional recovery cards, never startup state. */
export function receiveRecoveryRecords(storage: Pick<Storage, 'length' | 'key' | 'getItem'>, store: string, actor: string): RecoveryRecord[] {
  const prefix = `floor:pending-receive:${store}`;
  const records: RecoveryRecord[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key || key !== prefix && !key.startsWith(prefix + ':')) continue;
    try {
      const saved = JSON.parse(storage.getItem(key) || 'null') as ReceiveRequest;
      if (!saved || typeof saved.p_request !== 'string' || !saved.p_fields || !saved.p_extras || !Array.isArray(saved.p_photos)) {
        records.push({ key, request: null }); continue;
      }
      if (saved.p_photos.some(path => typeof path === 'string' && path.startsWith(`${store}/receive/${actor}/`))) records.push({ key, request: saved });
    } catch { records.push({ key, request: null }); }
  }
  return records;
}
