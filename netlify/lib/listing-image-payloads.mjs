const isHttps = value => typeof value === 'string' && /^https:\/\//i.test(value);

/** Stock catalog images first, then actual unit photos. The real-photo guard keeps
 * the API callers from accidentally replacing an open-box listing with catalog-only art. */
export function orderedListingImages(stockUrls, unitUrls, limit = 9) {
  const own = [...new Set((unitUrls || []).filter(isHttps))];
  if (!own.length) throw new Error('actual_unit_photo_required');
  const all = [...new Set([...(stockUrls || []).filter(isHttps), ...own])];
  const selected = all.slice(0, Math.max(1, Number(limit) || 9));
  if (!selected.some(url => own.includes(url))) selected[selected.length - 1] = own[0];
  return selected;
}

export function amazonImageLocatorPatches(urls, marketplaceId) {
  const keys = ['main_product_image_locator', ...Array.from({ length: 8 }, (_, i) => `other_product_image_locator_${i + 1}`)];
  const safe = (urls || []).filter(isHttps).slice(0, keys.length);
  if (!safe.length) throw new Error('https_image_required');
  return keys.map((key, i) => safe[i]
    ? { op: 'replace', path: `/attributes/${key}`, value: [{ media_location: safe[i], marketplace_id: marketplaceId }] }
    : { op: 'delete', path: `/attributes/${key}` });
}

export function tiktokMainImagePayload(uris) {
  return (uris || []).filter(uri => typeof uri === 'string' && uri.trim()).slice(0, 9).map(uri => ({ uri }));
}
