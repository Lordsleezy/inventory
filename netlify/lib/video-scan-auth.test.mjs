import test from 'node:test';
import assert from 'node:assert/strict';
import { scanWorkerHeader, validWorkerHeader } from './video-scan-auth.mjs';

test('scan worker signature is bound to one job and expires', () => {
  process.env.SUPABASE_SERVICE_ROLE = 'test-only-worker-secret';
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const header = scanWorkerHeader(first);
  assert.equal(validWorkerHeader({ headers: { 'x-floor-scan-worker': header } }, first), true);
  assert.equal(validWorkerHeader({ headers: { 'x-floor-scan-worker': header } }, second), false);
  const old = `${Math.floor(Date.now() / 1000) - 301}.${header.split('.')[1]}`;
  assert.equal(validWorkerHeader({ headers: { 'x-floor-scan-worker': old } }, first), false);
});
