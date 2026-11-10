import type { SupabaseClient } from '@supabase/supabase-js';

export type UnitPhoto = {
  id: number;
  sku: string;
  path: string;
  source: string | null;
  is_primary: boolean;
  sort_order: number | null;
};

/** Signed URLs are minted for 3600s; refresh before expiry. */
const URL_TTL_MS = 50 * 60 * 1000;
const SESSION_KEY = 'floor_photo_urls_v1';
const memoryCache = new Map<string, { url: string; at: number }>();

function cacheGet(path: string): string | null {
  const row = memoryCache.get(path);
  if (!row) return null;
  if (Date.now() - row.at > URL_TTL_MS) {
    memoryCache.delete(path);
    return null;
  }
  return row.url;
}

function cacheSet(path: string, url: string) {
  memoryCache.set(path, { url, at: Date.now() });
}

/** Hydrate memory cache from sessionStorage (per browser tab). */
export function hydratePhotoUrlCache(scope: string) {
  try {
    const raw = sessionStorage.getItem(`${SESSION_KEY}:${scope}`);
    if (!raw) return;
    const pack = JSON.parse(raw) as { at: number; urls: Record<string, string> };
    if (!pack?.at || Date.now() - pack.at > URL_TTL_MS) return;
    for (const [path, url] of Object.entries(pack.urls || {})) {
      if (url) cacheSet(path, url);
    }
  } catch { /* quota / private mode */ }
}

export function persistPhotoUrlCache(scope: string, urls: Record<string, string>) {
  try {
    const merged: Record<string, string> = {};
    for (const [path, row] of memoryCache.entries()) {
      if (Date.now() - (row?.at || 0) <= URL_TTL_MS && row?.url) merged[path] = row.url;
    }
    Object.assign(merged, urls);
    sessionStorage.setItem(`${SESSION_KEY}:${scope}`, JSON.stringify({ at: Date.now(), urls: merged }));
  } catch { /* quota */ }
}

/** Stock shots are manufacturer/pro photos. Everything else is a photo of this unit. */
export function isStockPhoto(photo: { source?: string | null }) {
  return String(photo.source || '').toLowerCase() === 'stock';
}

export function photoKind(photo: { source?: string | null }) {
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

/** List-view storage path: prefer 400px WebP derivative key (fallback at render if missing). */
export function listThumbStoragePath(originalPath: string | null | undefined): string | null {
  if (!originalPath) return null;
  return derivativePath(originalPath, 400) || originalPath;
}

export function listThumbPathsFromOriginals(paths: (string | null | undefined)[]): string[] {
  return [...new Set(paths.map(listThumbStoragePath).filter((p): p is string => Boolean(p)))];
}

export function listThumbPathsFromPhotoMap(photos: Record<string, UnitPhoto[]>): string[] {
  return listThumbPathsFromOriginals(
    Object.values(photos).map((rows) => listThumbPhoto(rows)?.path),
  );
}

export function listThumbOriginalPaths(photos: Record<string, UnitPhoto[]>): string[] {
  return [...new Set(
    Object.values(photos).map((rows) => listThumbPhoto(rows)?.path).filter((path): path is string => Boolean(path)),
  )];
}

/** Prefer the 400px derivative. Use the original file when that derivative was not signed. */
export function photoDisplayUrl(path: string | null | undefined, urls: Record<string, string>, size: 400 | 1200 = 400): string {
  if (!path) return '';
  const thumb = derivativePath(path, 400);
  const detail = derivativePath(path, 1200);
  if (size === 1200) return (detail && urls[detail]) || urls[path] || (thumb && urls[thumb]) || '';
  return (thumb && urls[thumb]) || urls[path] || '';
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

export async function signOnePhotoUrl(client: SupabaseClient, path: string) {
  const hit = cacheGet(path);
  if (hit) return hit;
  const { data, error } = await client.storage.from('unit-photos').createSignedUrl(path, 3600);
  if (error) return null;
  const url = data?.signedUrl || null;
  if (url) cacheSet(path, url);
  return url;
}

/**
 * List thumbs. Signs the 400px WebP, then the original file for any photo
 * whose derivative is missing. Older unit photos were never given a WebP.
 */
export async function signListThumbs(client: SupabaseClient, originalPaths: (string | null | undefined)[]) {
  const originals = [...new Set(originalPaths.filter((path): path is string => Boolean(path)))];
  const signed = await signPhotoUrls(client, originals.map((path) => listThumbStoragePath(path) || path));
  const missing = originals.filter((path) => {
    const thumb = listThumbStoragePath(path);
    return !(thumb && signed[thumb]) && !signed[path];
  });
  if (missing.length) Object.assign(signed, await signPhotoUrls(client, missing));
  return signed;
}

/** Signed URLs for storage paths that exist. Uses an in-memory cache so tabs do not re-sign every navigation. */
export async function signPhotoUrls(client: SupabaseClient, paths: string[]) {
  const keys = [...new Set(paths.filter(Boolean))];
  const out: Record<string, string> = {};
  const need: string[] = [];
  for (const key of keys) {
    const hit = cacheGet(key);
    if (hit) out[key] = hit;
    else need.push(key);
  }
  if (!need.length) return out;
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    const { data, error } = await client.storage.from('unit-photos').createSignedUrls(chunk, 3600);
    if (error) throw error;
    for (const row of data || []) {
      if (row?.path && row.signedUrl && !row.error) {
        out[row.path] = row.signedUrl;
        cacheSet(row.path, row.signedUrl);
      }
    }
  }
  return out;
}
