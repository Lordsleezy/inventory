import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { commitReceive } from './receiveCommit.ts';

test('lost commit response retries the same snapshot with one RPC and no second upload', async () => {
  const cache = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => cache.get(k) || null, setItem: (k: string, v: string) => cache.set(k, v), removeItem: (k: string) => cache.delete(k),
  } });
  const requests: unknown[] = [];
  const client = { rpc: async (name: string, payload: unknown) => {
    assert.equal(name, 'receive_commit'); requests.push(payload);
    return requests.length === 1 ? { data: null, error: { message: 'network lost after commit' } }
      : { data: { skus: ['54001'], server_ms: 12, replayed: true }, error: null };
  } } as unknown as SupabaseClient;
  const original = { p_request: 'same-request', p_fields: { p_title: 'Actual photo item' }, p_photos: ['store/receive/actor/same-request/unit.jpg'], p_extras: { location: null } };
  await assert.rejects(commitReceive(client, 'store', original), /Save is not confirmed/);
  assert.equal(cache.size, 1);
  const result = await commitReceive(client, 'store', { ...original, p_fields: { p_title: 'changed after timeout' } });
  assert.equal(result.replayed, true); assert.equal(cache.size, 0);
  assert.deepEqual(requests, [original, original]);
});
