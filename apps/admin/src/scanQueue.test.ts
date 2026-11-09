import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldQueueScan } from './scanQueue.ts';

test('blank scans are dropped', () => {
  assert.equal(shouldQueueScan('  ', null, 1000), false);
});

test('a new code is queued', () => {
  assert.equal(shouldQueueScan('9400', null, 1000), true);
});

test('the same code inside 2 seconds is dropped', () => {
  assert.equal(shouldQueueScan('9400', { code: '9400', at: 1000 }, 2500), false);
});

test('the same code after 2 seconds is queued again', () => {
  assert.equal(shouldQueueScan('9400', { code: '9400', at: 1000 }, 3000), true);
});

test('a different code during the window is kept', () => {
  assert.equal(shouldQueueScan('9401', { code: '9400', at: 1000 }, 1500), true);
});
