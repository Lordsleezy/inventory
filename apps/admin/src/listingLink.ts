/** Build a public listing URL from a channel + stored listing_id (URL or marketplace id). */
export function listingLink(channel: string, listingId: string | null | undefined): string | null {
  const id = String(listingId || '').trim();
  if (!id) return null;
  if (/^https?:\/\//i.test(id)) return id;
  const ch = String(channel || '').toLowerCase();
  if (ch === 'ebay') return `https://www.ebay.com/itm/${encodeURIComponent(id)}`;
  if (ch === 'amazon') return `https://www.amazon.com/dp/${encodeURIComponent(id)}`;
  return null;
}
