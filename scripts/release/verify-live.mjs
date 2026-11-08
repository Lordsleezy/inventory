#!/usr/bin/env node
/** Fetch production admin build.json and require it matches the release SHA. */
export async function verifyAdminLive(sha) {
  const short = sha.slice(0, 7);
  const url = 'https://admin.openboxindustries.com/build.json';
  let res;
  try {
    res = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(`Could not reach admin build.json: ${err?.message || err}`);
  }
  if (!res.ok) {
    throw new Error(`admin build.json returned ${res.status} (expected 200 after deploy)`);
  }
  const body = await res.json();
  const liveSha = String(body.sha || '');
  if (!liveSha.startsWith(short) && !sha.startsWith(liveSha.slice(0, 7))) {
    throw new Error(`admin live build ${liveSha.slice(0, 7)} does not match release ${short}`);
  }
  return { url, sha: liveSha, builtAt: body.builtAt || '' };
}
