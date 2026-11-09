import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSOCIATE_LINKS,
  OWNER_EXTRA_LINKS,
  OWNER_LINKS,
  deskAllowedPages,
  deskNavGroups,
  deskRoleLabel,
  resolveDeskAccess,
} from './deskNav.ts';

test('owner desk is staff links plus Reports, Safe, Manifests, Books', () => {
  assert.deepEqual(
    OWNER_LINKS.map((l) => l.label),
    [...ASSOCIATE_LINKS.map((l) => l.label), 'Reports', 'Safe', 'Manifests', 'Books'],
  );
  assert.deepEqual(
    OWNER_EXTRA_LINKS.map((l) => l.page),
    ['reports', 'withdrawals', 'manifests', 'books'],
  );
});

test('resolveDeskAccess: owner beats portal admin', () => {
  assert.equal(resolveDeskAccess('owner', true), 'owner');
  assert.equal(resolveDeskAccess('owner', false), 'owner');
  assert.equal(resolveDeskAccess('manager', false), 'admin');
  assert.equal(resolveDeskAccess('staff', true), 'admin');
  assert.equal(resolveDeskAccess('staff', false), 'staff');
  assert.equal(resolveDeskAccess(null, false), 'staff');
});

test('owner nav is a single Your desk group with owner links', () => {
  const groups = deskNavGroups('owner');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'Your desk');
  assert.equal(groups[0].links, OWNER_LINKS);
  assert.equal(deskRoleLabel('owner'), 'Owner');
});

test('owner allowed pages exclude channels and live sales', () => {
  const pages = deskAllowedPages('owner');
  assert.ok(pages);
  for (const page of ['reports', 'withdrawals', 'manifests', 'books', 'register', 'inventory', 'orders'] as const) {
    assert.ok(pages.includes(page), page);
  }
  for (const page of ['sales', 'returns', 'ebay', 'depop', 'amazon', 'dropship', 'insights'] as const) {
    assert.equal(pages.includes(page), false, page);
  }
  assert.equal(deskAllowedPages('admin'), null);
});
