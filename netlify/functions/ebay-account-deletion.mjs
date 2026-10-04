import { json } from '../lib/server.mjs';
import { deletionChallenge, handleDeletionPost } from '../lib/ebay-account-deletion.mjs';

export async function handler(event) {
  if (event.httpMethod === 'GET') {
    const code = event.queryStringParameters?.challenge_code;
    if (!code) return json(400, { error: 'missing_challenge' });
    return json(200, { challengeResponse: deletionChallenge(code) });
  }
  if (event.httpMethod === 'POST') return handleDeletionPost(event);
  return json(405, { error: 'method_not_allowed' });
}
