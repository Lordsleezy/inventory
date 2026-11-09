import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSOCIATE_LINKS,
  OWNER_DESK_GROUPS,
  OWNER_JUMP_LINKS,
  deskAllowedPages,
  deskNavGroups,
  deskRoleLabel,
  resolveDeskAccess,
} from './deskNav.ts';

test('owner desk groups match Sell / Stock / Money / System', () => {
  const labels = OWNER_DESK_GROUPS.map((g) => g.label);
  assert.deepEqual(labels, ['Sell', 'Stock', 'Money', 'System']);
  const pages = OWNER_DESK_GROUPS.flatMap((g) => g.links.map((l) => l.page));
  assert.ok(pages.includes('cameras'));
  assert.ok(pages.includes('manifests'));
  assert.ok(!pages.includes('sales'));
});

test('resolveDeskAccess: owner beats portal admin', () => {
  assert.equal(resolveDeskAccess('owner', true), 'owner');
  assert.equal(resolveDeskAccess('owner', false), 'owner');
  assert.equal(resolveDeskAccess('manager', false), 'admin');
  assert.equal(resolveDeskAccess('staff', true), 'admin');
  assert.equal(resolveDeskAccess('staff', false), 'staff');
  assert.equal(resolveDeskAccess(null, false), 'staff');
});

test('owner nav uses grouped sidebar', () => {
  const groups = deskNavGroups('owner');
  assert.equal(groups, OWNER_DESK_GROUPS);
  assert.equal(deskRoleLabel('owner'), 'Owner');
});

test('owner allowed pages include cameras and exclude channels', () => {
  const pages = deskAllowedPages('owner');
  assert.ok(pages);
  for (const page of ['reports', 'withdrawals', 'manifests', 'books', 'cameras', 'register', 'inventory', 'orders'] as const) {
    assert.ok(pages.includes(page), page);
  }
  for (const page of ['sales', 'returns', 'ebay', 'depop', 'amazon', 'dropship', 'insights'] as const) {
    assert.equal(pages.includes(page), false, page);
  }
  assert.equal(deskAllowedPages('admin'), null);
});

test('owner jump grid has six outline destinations', () => {
  assert.equal(OWNER_JUMP_LINKS.length, 6);
  assert.deepEqual(
    OWNER_JUMP_LINKS.map((l) => l.label),
    ['Reports', 'Books', 'Safe', 'Manifests', 'Cameras', 'Locations'],
  );
  assert.equal(ASSOCIATE_LINKS.length, 6);
});
