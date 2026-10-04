import { createHash, createPublicKey, createVerify } from 'node:crypto';
import { json, requireEnv, serviceClient } from './server.mjs';

const keys = new Map();
let appToken;
const endpoint = () => requireEnv('EBAY_DELETION_ENDPOINT_URL');
const verificationToken = () => requireEnv('EBAY_DELETION_VERIFICATION_TOKEN');

export function deletionChallenge(code) {
  return createHash('sha256').update(code + verificationToken() + endpoint()).digest('hex');
}

function decodeSignature(header) {
  if (!header || !/^[A-Za-z0-9+/]+={0,2}$/.test(header) || header.length > 4096)
    throw new Error('invalid_signature_header');
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(decoded.kid || '') ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(decoded.signature || ''))
    throw new Error('invalid_signature_header');
  return decoded;
}

async function productionAppToken() {
  if (appToken?.expires > Date.now()) return appToken.value;
  const id = process.env.EBAY_DELETION_CLIENT_ID || requireEnv('EBAY_CLIENT_ID');
  const secret = process.env.EBAY_DELETION_CLIENT_SECRET || requireEnv('EBAY_CLIENT_SECRET');
  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('ebay_production_credentials_unavailable');
  const body = await response.json();
  if (!body.access_token) throw new Error('ebay_production_token_missing');
  appToken = { value: body.access_token, expires: Date.now() + Math.min(Number(body.expires_in || 7200) * 1000 - 60_000, 3_600_000) };
  return appToken.value;
}

async function publicKey(kid) {
  const cached = keys.get(kid);
  if (cached?.expires > Date.now()) return cached.key;
  const token = await productionAppToken();
  const response = await fetch(`https://api.ebay.com/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('ebay_public_key_unavailable');
  const body = await response.json();
  const pem = String(body.key || '').replace(/-----BEGIN PUBLIC KEY-----\s*/, '-----BEGIN PUBLIC KEY-----\n')
    .replace(/\s*-----END PUBLIC KEY-----/, '\n-----END PUBLIC KEY-----');
  const key = createPublicKey(pem);
  keys.set(kid, { key, expires: Date.now() + 3_600_000 });
  return key;
}

export async function verifyDeletionSignature(body, header, fetchKey = publicKey) {
  const { kid, signature } = decodeSignature(header);
  const key = await fetchKey(kid);
  // eBay's Event Notification SDK verifies JSON.stringify(parsed message).
  // The raw body is also accepted if an intermediary preserved whitespace.
  const variants = [body];
  try { variants.push(JSON.stringify(JSON.parse(body))); } catch { return false; }
  return variants.some(value => {
    const verifier = createVerify('ssl3-sha1');
    verifier.update(value);
    return verifier.verify(key, signature, 'base64');
  });
}

export async function handleDeletionPost(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
  if (raw.length > 65_536) return json(413, { error: 'payload_too_large' });
  let valid;
  try {
    valid = await verifyDeletionSignature(raw,
      event.headers?.['x-ebay-signature'] || event.headers?.['X-EBAY-SIGNATURE']);
  } catch (error) {
    if (String(error.message).startsWith('ebay_')) return json(503, { error: 'signature_key_unavailable' });
    return json(412, { error: 'invalid_signature' });
  }
  if (!valid) return json(412, { error: 'invalid_signature' });
  let payload;
  try { payload = JSON.parse(raw); } catch { return json(400, { error: 'invalid_json' }); }
  if (payload.metadata?.topic !== 'MARKETPLACE_ACCOUNT_DELETION') return json(400, { error: 'wrong_topic' });
  const notice = payload.notification;
  const buyer = notice?.data || {};
  if (!notice?.notificationId || !(buyer.userId || buyer.username || buyer.eiasToken))
    return json(400, { error: 'missing_deletion_identifiers' });
  const { data, error } = await serviceClient().rpc('anonymize_ebay_buyer', {
    p_notification_id: notice.notificationId,
    p_user_id: buyer.userId || null,
    p_username: buyer.username || null,
    p_eias_token: buyer.eiasToken || null,
  });
  if (error) return json(500, { error: 'anonymization_failed' });
  console.info('ebay_account_deletion_processed', JSON.stringify({ orders_anonymized: data }));
  return { statusCode: 204, body: '' };
}
