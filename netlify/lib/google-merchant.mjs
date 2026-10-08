function env(name) { const v = process.env[name]; if (!v) throw new Error(`Missing ${name}`); return v; }
export async function merchantAccessToken() {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env('GOOGLE_OAUTH_CLIENT_ID'),
      refresh_token: env('GOOGLE_REFRESH_TOKEN'),
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Google OAuth ${response.status}: ${String(data.error || 'token request failed')}`);
  return data.access_token;
}
export async function merchantRequest(path, method = 'GET', body) {
  const token = await merchantAccessToken();
  const response = await fetch(`https://merchantapi.googleapis.com/${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) { const text = await response.text(); throw new Error(`Merchant API ${response.status}: ${text.slice(0,400)}`); }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
