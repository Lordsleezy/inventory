import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totalsBalance } from './totalsMath.ts';

test('listed + not listed + defective must equal total', () => {
  assert.equal(totalsBalance({ total: 712, listed: 604, not_listed: 41, defective: 67 }), true);
  assert.equal(totalsBalance({ total: 712, listed: 604, not_listed: 40, defective: 67 }), false);
});

test('DNS is a separate physical stock bucket', () => {
  assert.equal(totalsBalance({ total: 738, listed: 474, not_listed: 164, defective: 62, dns: 38 }), true);
  assert.equal(totalsBalance({ total: 738, listed: 474, not_listed: 202, defective: 62, dns: 38 }), false);
});
