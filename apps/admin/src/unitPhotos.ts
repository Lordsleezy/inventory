import type { SupabaseClient } from '@supabase/supabase-js';

export type UnitPhoto = {
  id: number;
  sku: string;
  path: string;
  source: string | null;
  is_primary: boolean;
  sort_order: number | null;
};

/** Stock shots are manufacturer/pro photos. Everything else is a photo of this unit. */
export function isStockPhoto(photo: { source?: string | null }) {
  return String(photo.source || '').toLowerCase() === 'stock';
}

export function photoKind(photo: { source?: string | null }): 'Real photo' | 'Stock photo' {
  return isStockPhoto(photo) ? 'Stock photo' : 'Real photo';
}

/**
 * Order screen only. Real unit photos lead, so the warehouse sees the box first.
 * Listing galleries keep their own order.
 */
export function orderScreenPhotos<T extends { source?: string | null; sort_order?: number | null; id?: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const realFirst = Number(isStockPhoto(a)) - Number(isStockPhoto(b));
    if (realFirst) return realFirst;
    const sort = (a.sort_order ?? 0) - (b.sort_order ?? 0);
    if (sort) return sort;
    return (a.id ?? 0) - (b.id ?? 0);
  });
}

export function listThumbPhoto<T extends { source?: string | null; sort_order?: number | null; id?: number }>(rows: T[]): T | null {
  return orderScreenPhotos(rows)[0] ?? null;
}

/** Same key as packages/cloud webDerivativePath: {store}/{sku}/web/{400|1200}/{stem}.webp */
export function derivativePath(path: string, size: 400 | 1200): string | null {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length >= 5 && parts[2] === 'web' && (parts[3] === '400' || parts[3] === '1200')) return path;
  if (parts.length < 3 || parts[1] === 'archive') return null;
  const file = parts[parts.length - 1] || 'photo.jpg';
  const stem = file.replace(/\.[^.]+$/, '') || 'photo';
  return `${parts[0]}/${parts[1]}/web/${size}/${stem}.webp`;
}

export async function loadUnitPhotos(client: SupabaseClient, storeId: string, skus: string[]) {
  const unique = [...new Set(skus.filter((sku) => sku && sku !== 'UNMATCHED'))];
  const grouped: Record<string, UnitPhoto[]> = {};
  for (let i = 0; i < unique.length; i += 80) {
    const chunk = unique.slice(i, i + 80);
    const { data, error } = await client.from('photos')
      .select('id,sku,path,source,is_primary,sort_order')
      .eq('store_id', storeId)
      .in('sku', chunk);
    if (error) throw error;
    for (const row of data || []) {
      const photo = row as UnitPhoto;
      (grouped[photo.sku] ||= []).push(photo);
    }
  }
  for (const sku of Object.keys(grouped)) grouped[sku] = orderScreenPhotos(grouped[sku]);
  return grouped;
}

/** Signed URLs for the paths that exist. Missing derivatives come back without a URL. */
export async function signPhotoUrls(client: SupabaseClient, paths: string[]) {
  const keys = [...new Set(paths.filter(Boolean))];
  const out: Record<string, string> = {};
  for (let i = 0; i < keys.length; i += 40) {
    const chunk = keys.slice(i, i + 40);
    const { data } = await client.storage.from('unit-photos').createSignedUrls(chunk, 3600);
    for (const row of data || []) {
      if (row?.path && row.signedUrl && !row.error) out[row.path] = row.signedUrl;
    }
  }
  return out;
}
