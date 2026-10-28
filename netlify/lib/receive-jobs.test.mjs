import test from 'node:test';
import assert from 'node:assert/strict';
import { executeReceiveJob, receiveRetrySeconds } from './receive-job-runner.mjs';

test('failed receive work survives a retry, retaining completed steps', async () => {
  const job = { sku: '54001', attempts: 1, completed_steps: [] };
  const calls = [];
  let fail = true;
  const step = async name => { calls.push(name); if (name === 'categories' && fail) throw new Error('temporary outage'); };
  const save = async patch => Object.assign(job, patch);
  await executeReceiveJob(job, { step, save, now: () => 0 });
  assert.equal(job.status, 'retry');
  assert.deepEqual(job.completed_steps, ['photos', 'autofill']);
  assert.equal(job.next_attempt_at, '1970-01-01T00:00:30.000Z');
  fail = false;
  await executeReceiveJob(job, { step, save });
  assert.equal(job.status, 'done');
  assert.deepEqual(calls, ['photos', 'autofill', 'categories', 'categories', 'channels', 'visibility']);
  assert.equal(job.lease, null);
});

test('retries keep backing off without silently abandoning the item', () => {
  assert.equal(receiveRetrySeconds(1), 30);
  assert.equal(receiveRetrySeconds(30), 900);
});
