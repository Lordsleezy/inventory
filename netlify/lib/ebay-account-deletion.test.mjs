import test from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { deletionChallenge, verifyDeletionSignature } from './ebay-account-deletion.mjs';
import { handler } from '../functions/ebay-account-deletion.mjs';

test('eBay challenge hashes the exact configured URL and token', async () => {
  process.env.EBAY_DELETION_ENDPOINT_URL = 'https://inventoryobi.netlify.app/.netlify/functions/ebay-account-deletion';
  process.env.EBAY_DELETION_VERIFICATION_TOKEN = 'test_token_0123456789abcdef0123456789';
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
