/**
 * Maintain listings.photo_ids for Depop (and optionally Mercari) from public listing pages
 * or an explicit backfill payload. Matching on sale emails is exact photo-id only.
 *
 * Env:
 *   DEPOP_SHOP_USERNAME  public @handle (optional; enables shop crawl when Depop allows)
 */

const PHOTO_RE = /media-photos\.depop\.com\/b\d+\/\d+\/(\d+)_[0-9a-f]+\//gi;

export function photoIdsFromHtml(html) {
  const ids = new Set();
  for (const m of String(html || '').matchAll(PHOTO_RE)) if (m[1]) ids.add(m[1]);
  return [...ids];
}

export async function fetchDepopProductHtml(listingId, { fetchImpl = fetch, username } = {}) {
  const id = String(listingId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const candidates = [
    `https://www.depop.com/products/${id}/`,
    username ? `https://www.depop.com/${encodeURIComponent(username)}/products/${id}/` : null,
    `https://webapi.depop.com/api/v1/products/${id}/`,
    `https://webapi.depop.com/api/v2/product/${id}/`,
  ].filter(Boolean);
  const headers = {
    Accept: 'text/html,application/json',
    'User-Agent':
      'Mozilla/5.0 (compatible; OpenBoxFloor/1.0; +https://openboxindustries.com)',
  };
  for (const url of candidates) {
    try {
      const res = await fetchImpl(url, { headers, redirect: 'follow' });
      if (!res.ok) continue;
      const body = await res.text();
      if (body && !/Forbidden|Just a moment/i.test(body.slice(0, 400))) {
        return { url, body };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Backfill/update photo_ids for listed Depop rows.
 * `manual` is [{ sku, listing_id?, photo_ids: string[] }] for agent/admin import when crawl is blocked.
 */
export async function syncDepopListingPhotos(sb, {
  storeId,
  username = process.env.DEPOP_SHOP_USERNAME || '',
  manual = [],
  fetchImpl = fetch,
  limit = 80,
} = {}) {
  if (!username && storeId) {
    const { data: row } = await sb
      .from('store_settings')
      .select('value')
      .eq('store_id', storeId)
      .eq('key', 'depop_shop_username')
      .maybeSingle();
    const v = row?.value;
    username = typeof v === 'string' ? v : v != null ? String(v) : '';
    username = username.replace(/^"|"$/g, '').trim();
  }
  const summary = {
    listed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    with_photos: 0,
    errors: [],
    source: manual.length ? 'manual' : username ? 'crawl' : 'none',
  };

  if (Array.isArray(manual) && manual.length) {
    for (const row of manual) {
      const sku = String(row.sku || '').trim();
      const photo_ids = [...new Set((row.photo_ids || []).map(String).filter((x) => /^\d{6,}$/.test(x)))];
      if (!sku || !photo_ids.length) {
        summary.skipped++;
        continue;
      }
      const { error } = await sb
        .from('listings')
        .update({ photo_ids })
        .eq('store_id', storeId)
        .eq('sku', sku)
        .eq('channel', 'depop');
      if (error) {
        summary.failed++;
        if (summary.errors.length < 8) summary.errors.push(`${sku}: ${error.message}`);
      } else {
        summary.updated++;
        summary.with_photos++;
      }
    }
    return summary;
  }

  const { data: rows, error } = await sb
    .from('listings')
    .select('sku, listing_id, photo_ids')
    .eq('store_id', storeId)
    .eq('channel', 'depop')
    .eq('status', 'listed')
    .order('sku')
    .limit(limit);
  if (error) throw error;
  summary.listed = (rows || []).length;

  for (const row of rows || []) {
    if (!row.listing_id) {
      summary.skipped++;
      continue;
    }
    const got = await fetchDepopProductHtml(row.listing_id, { fetchImpl, username: username || undefined });
    if (!got) {
      summary.failed++;
      if (summary.errors.length < 8) summary.errors.push(`${row.sku}: fetch_blocked`);
      continue;
    }
    const ids = photoIdsFromHtml(got.body);
    if (!ids.length) {
      summary.skipped++;
      continue;
    }
    const merged = [...new Set([...(row.photo_ids || []), ...ids])];
    const { error: upErr } = await sb
      .from('listings')
      .update({ photo_ids: merged })
      .eq('store_id', storeId)
      .eq('sku', row.sku)
      .eq('channel', 'depop');
    if (upErr) {
      summary.failed++;
      if (summary.errors.length < 8) summary.errors.push(`${row.sku}: ${upErr.message}`);
    } else {
      summary.updated++;
      summary.with_photos++;
    }
  }
  return summary;
}

export async function countDepopPhotoCoverage(sb, storeId) {
  const { data, error } = await sb
    .from('listings')
    .select('sku, photo_ids')
    .eq('store_id', storeId)
    .eq('channel', 'depop')
    .eq('status', 'listed');
  if (error) throw error;
  const listed = (data || []).length;
  const withPhotos = (data || []).filter((r) => (r.photo_ids || []).length > 0).length;
  return { listed, with_photos: withPhotos, missing: listed - withPhotos };
}
