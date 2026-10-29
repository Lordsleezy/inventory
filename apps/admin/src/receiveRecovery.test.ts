import test from 'node:test';
import assert from 'node:assert/strict';
import { receiveRecoveryRecords } from './receiveRecovery.ts';
import { commitReceive } from './receiveCommit.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

function store(values: Record<string, string>) {
  const cache = new Map(Object.entries(values));
  return { get length() { return cache.size; }, key: (index: number) => [...cache.keys()][index] || null,
    getItem: (key: string) => cache.get(key) || null, setItem: (key: string,value: string) => { cache.set(key,value); }, removeItem: (key: string) => { cache.delete(key); } };
}
test('legacy, malformed and multiple recovery records are optional, scoped cards', () => {
  const request = { p_request: 'old', p_fields: { p_title: 'Jewelry organizer box, White and Gold' }, p_extras: {}, p_photos: ['store/receive/jacob/old/photo.jpg'] };
  const storage = store({
    'floor:pending-receive:store': JSON.stringify(request),
    'floor:pending-receive:store:bad': '{invalid',
    'floor:pending-receive:store:other-user': JSON.stringify({ ...request,p_photos: ['store/receive/paul/old/photo.jpg'] }),
    'floor:pending-receive:other': JSON.stringify(request),
  });
  const records = receiveRecoveryRecords(storage, 'store', 'jacob');
  assert.equal(records.length, 2); assert.equal(records[0].request?.p_request, 'old'); assert.equal(records[1].request, null);
  assert.equal(storage.length, 4, 'reading recovery never mutates or auto-opens drafts');
});
test('a malformed legacy draft never prevents a new idempotent save', async () => {
  const storage = store({ 'floor:pending-receive:store': '{invalid' });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const request = { p_request: 'new',p_fields: {},p_extras: {},p_photos: ['store/receive/jacob/new/photo.jpg'] };
  const client = { rpc: async () => ({ data: { skus: ['99879'] },error: null }) } as unknown as SupabaseClient;
  assert.deepEqual((await commitReceive(client,'store',request)).skus, ['99879']);
  assert.equal(storage.getItem('floor:pending-receive:store'), '{invalid', 'old data retained until explicit Discard');
});
