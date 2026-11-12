import test from 'node:test';
import assert from 'node:assert/strict';
import { viewerIsJacob } from './books/personMerge.ts';

test('the payout box is for Jacob only', () => {
  assert.equal(viewerIsJacob('Jacob', 'jacob.store@employees.floor.local'), true);
  assert.equal(viewerIsJacob('', 'jacob.store@employees.floor.local'), true);
  assert.equal(viewerIsJacob('Paul', 'pgg124@gmail.com'), false);
  assert.equal(viewerIsJacob('Steve', 'steve@openboxindustries.com'), false);
});
