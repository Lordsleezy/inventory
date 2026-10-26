import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totalsBalance } from './totalsMath.ts';

test('listed + not listed + defective must equal total', () => {
  assert.equal(totalsBalance({ total: 712, listed: 604, not_listed: 41, defective: 67 }), true);
  assert.equal(totalsBalance({ total: 712, listed: 604, not_listed: 40, defective: 67 }), false);
});
