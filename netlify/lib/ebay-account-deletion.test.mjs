import test from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { authorizeEbayNotifyPost, deletionChallenge, verifyDeletionSignature } from './ebay-account-deletion.mjs';
import { invoke as handler } from '../functions/ebay-account-deletion.mjs';
import { invoke as notify } from '../functions/ebay-notify.mjs';

test('eBay challenge hashes the exact configured URL and token', async () => {
  process.env.EBAY_DELETION_ENDPOINT_URL = 'https://example.invalid/ebay-challenge';
  process.env.EBAY_DELETION_VERIFICATION_TOKEN = 'fake-ebay-deletion-verification-token';
  const response = await handler({ httpMethod: 'GET', queryStringParameters: { challenge_code: 'abc123' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(response.body).challengeResponse, deletionChallenge('abc123'));
});

test('signature verification binds the exact notification payload', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const body = JSON.stringify({ metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION' }, notification: { notificationId: 'test' } });
  const signer = createSign('ssl3-sha1');
  signer.update(body);
  const header = Buffer.from(JSON.stringify({ kid: 'test-key', signature: signer.sign(privateKey, 'base64') })).toString('base64');
  const key = async kid => { assert.equal(kid, 'test-key'); return publicKey; };
  assert.equal(await verifyDeletionSignature(body, header, key), true);
  assert.equal(await verifyDeletionSignature(body.replace('test', 'tast'), header, key), false);
  assert.equal(await verifyDeletionSignature(body, '', key).catch(() => false), false);
});

test('unsigned ebay-notify POST is rejected and does not poll', async () => {
  delete process.env.EBAY_DISABLED;
  const response = await notify({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ metadata: { topic: 'MARKETPLACE_ORDER' }, notification: { notificationId: 'unsigned' } }),
  });
  assert.equal(response.statusCode, 412);
  assert.equal(JSON.parse(response.body).error, 'invalid_signature');
  const garbage = await notify({ httpMethod: 'POST', headers: {}, body: 'not-json' });
  assert.equal(garbage.statusCode, 412);
  assert.equal(JSON.parse(garbage.body).error, 'invalid_signature');
});

test('ebay-notify stops when the signature key cannot be fetched', async () => {
  const gate = await authorizeEbayNotifyPost({
    httpMethod: 'POST',
    headers: { 'x-ebay-signature': Buffer.from(JSON.stringify({ kid: 'missing', signature: 'aaaa' })).toString('base64') },
    body: JSON.stringify({ metadata: { topic: 'MARKETPLACE_ORDER' } }),
  }, async () => { throw new Error('ebay_public_key_unavailable'); });
  assert.equal(gate.kind, 'stop');
  assert.equal(gate.response.statusCode, 503);
});
