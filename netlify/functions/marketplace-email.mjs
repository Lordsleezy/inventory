import PostalMime from 'postal-mime';
import { json, serviceClient } from '../lib/server.mjs';
import { wrapHandler } from '../lib/floor-log.mjs';
import { ingestMarketplaceMail, loadStoreChannels } from '../lib/marketplace-email-parse.mjs';

// Raw-email webhook (forwarder -> POST). The Gmail inbox poller (gmail-sales-poll) shares the same parse + ingest code.
async function handle(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!process.env.MARKETPLACE_EMAIL_SECRET) return json(503, { error: 'email_ingest_not_configured' });
  if (event.headers['x-marketplace-secret'] !== process.env.MARKETPLACE_EMAIL_SECRET) return json(401, { error: 'unauthorized' });
  try {
    const body = JSON.parse(event.body || '{}');
    const raw = Buffer.from(event.headers['x-raw-email-base64'] || body.raw || '', 'base64');
    if (raw.length > 4_300_000) return json(413, { error: 'email_too_large' });
    const sb = serviceClient();
    const { store, channels } = await loadStoreChannels(sb);
    const parsed = await new PostalMime().parse(raw);
    const result = await ingestMarketplaceMail(sb, { store, channels, parsed, raw });
    if (result.state === 'duplicate') return json(200, { duplicate: true });
    return json(200, result.state === 'matched' ? { state: 'matched', sku: result.sku } : { state: result.state });
  } catch (e) {
    return json(500, { error: String(e).slice(0, 300) });
  }
}
export const handler = wrapHandler('marketplace-email', handle);
