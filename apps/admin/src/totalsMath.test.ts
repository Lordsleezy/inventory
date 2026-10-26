import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totalsBalance, inventoryBucketStatus } from './totalsMath.ts';

test('listed + not listed + defective must equal total', () => {
  assert.equal(totalsBalance({ total: 712, listed: 604, not_listed: 41, defective: 67 }), true);
  assert.equal(totalsBalance({ total: 712, listed: 604, not_listed: 40, defective: 67 }), false);
});

test('ready and not-ready cards stay separate and point to their matching server filters', () => {
  assert.equal(totalsBalance({ total: 21, listed: 3, not_listed: 3, not_ready: 4, dns: 5, defective: 6 }), true);
  assert.equal(totalsBalance({ total: 21, listed: 3, not_listed: 7, not_ready: 4, dns: 5, defective: 6 }), false);
  assert.equal(inventoryBucketStatus('total'), 'inventory_total');
  assert.equal(inventoryBucketStatus('listed'), 'inventory_listed');
  assert.equal(inventoryBucketStatus('not_listed'), 'inventory_not_listed');
  assert.equal(inventoryBucketStatus('not_ready'), 'inventory_not_ready');
  assert.equal(inventoryBucketStatus('dns'), 'dns');
  assert.equal(inventoryBucketStatus('defective'), 'defective');
});

test('DNS is a separate physical stock bucket', () => {
  assert.equal(totalsBalance({ total: 738, listed: 474, not_listed: 164, defective: 62, dns: 38 }), true);
  assert.equal(totalsBalance({ total: 738, listed: 474, not_listed: 202, defective: 62, dns: 38 }), false);
});
