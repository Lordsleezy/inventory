import { createSign } from 'node:crypto';

function env(name) { const v = process.env[name]; if (!v) throw new Error(`Missing ${name}`); return v; }
export async function merchantAccessToken() {
  const acct = JSON.parse(Buffer.from(env('GOOGLE_SERVICE_ACCOUNT_JSON_B64'), 'base64').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: acct.client_email, scope: 'https://www.googleapis.com/auth/content', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sign = createSign('RSA-SHA256'); sign.update(unsigned);
  const assertion = `${unsigned}.${sign.sign(acct.private_key, 'base64url')}`;
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const data = await response.json(); if (!response.ok) throw new Error(`Google OAuth ${response.status}`); return data.access_token;
}
export async function merchantRequest(path, method = 'GET', body) {
  const token = await merchantAccessToken();
  const response = await fetch(`https://merchantapi.googleapis.com/${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) { const text = await response.text(); throw new Error(`Merchant API ${response.status}: ${text.slice(0,400)}`); }
  return response.status === 204 ? null : response.json();
}
