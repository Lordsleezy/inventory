import test from 'node:test';
import assert from 'node:assert/strict';
import { receiveAccessFromEvent, staffOwnsReceivedSkus } from './receive-auth.mjs';

function mockStaffDb({ staff, received = ['12345'] } = {}) {
  const filters = {};
  const query = {
    select() { return this; },
    eq(key, value) { filters[key] = value; return this; },
    is(key, value) { filters[key] = value; return this; },
    in(key, value) { filters[key] = value; return this; },
    async maybeSingle() { return { data: staff && (!filters.store_id || filters.store_id === staff.store_id) ? staff : null, error: null }; },
    then(resolve, reject) { return Promise.resolve({ data: received.filter(sku => (filters.sku || []).includes(sku)).map(sku => ({ sku })), error: null }).then(resolve, reject); },
  };
  return {
    auth: { async getUser(token) { return token === 'valid' ? { data: { user: { id: 'clerk-1', email: 'jacob@example.com' } }, error: null } : { data: { user: null }, error: new Error('bad token') }; } },
    from(table) { assert.ok(['staff', 'events'].includes(table)); return Object.create(query); },
  };
}

test('receive auth preserves admin access', async () => {
  const ctx = await receiveAccessFromEvent({ headers: {} }, 'store-admin', {
    adminAuth: async () => ({ storeId: 'store-admin', actor: 'admin', userId: 'admin-1' }),
  });
  assert.equal(ctx.isAdmin, true);
  assert.equal(ctx.storeId, 'store-admin');
});

test('receive auth allows active clerk only in their own store', async () => {
  const db = mockStaffDb({ staff: { store_id: 'store-1' } });
  const deps = { adminAuth: async () => { throw Object.assign(new Error('Admin access required'), { status: 403 }); }, getServiceClient: () => db };
  const ctx = await receiveAccessFromEvent({ headers: { authorization: 'Bearer valid' } }, 'store-1', deps);
  assert.equal(ctx.isAdmin, false);
  assert.equal(ctx.userId, 'clerk-1');
  assert.equal(ctx.storeId, 'store-1');
  await assert.rejects(receiveAccessFromEvent({ headers: { authorization: 'Bearer valid' } }, 'other-store', deps), { status: 403 });
});

test('receive auth refuses non-staff and invalid sessions', async () => {
  const deps = { adminAuth: async () => { throw Object.assign(new Error('Admin access required'), { status: 403 }); }, getServiceClient: () => mockStaffDb({}) };
  await assert.rejects(receiveAccessFromEvent({ headers: { authorization: 'Bearer valid' } }, null, deps), { status: 403 });
  await assert.rejects(receiveAccessFromEvent({ headers: {} }, null, deps), { status: 401 });
  await assert.rejects(receiveAccessFromEvent({ headers: { authorization: 'Bearer invalid' } }, null, deps), { status: 401 });
});

test('staff can confirm only SKUs they received; admins retain existing access', async () => {
  const db = mockStaffDb({ received: ['12345'] });
  const staff = { sb: db, storeId: 'store-1', userId: 'clerk-1', isAdmin: false };
  assert.equal(await staffOwnsReceivedSkus(staff, ['12345']), true);
  assert.equal(await staffOwnsReceivedSkus(staff, ['12345', '12346']), false);
  assert.equal(await staffOwnsReceivedSkus(staff, []), false);
  assert.equal(await staffOwnsReceivedSkus({ isAdmin: true }, ['elsewhere']), true);
});
