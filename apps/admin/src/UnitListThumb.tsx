import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReactNode } from 'react';
import { derivativePath, signOnePhotoUrl } from './unitPhotos';

type Props = {
  client: SupabaseClient;
  photoPath: string | null | undefined;
  urls: Record<string, string>;
  onUrl?: (path: string, url: string) => void;
  className?: string;
  eager?: boolean;
  placeholder?: ReactNode;
};

/** Fast list thumbnail: 400px WebP when available; lazily signs the original on error. */
export function UnitListThumb({
  client, photoPath, urls, onUrl, className, eager = false, placeholder = null,
}: Props) {
  if (!photoPath) return placeholder;
  const thumbPath = derivativePath(photoPath, 400);
  const src = (thumbPath && urls[thumbPath]) || urls[photoPath] || '';
  if (!src) return placeholder;
  return (
    <img
      className={className}
      src={src}
      alt=""
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      fetchPriority={eager ? 'high' : 'auto'}
      onError={(e) => {
        const img = e.currentTarget;
        if (!photoPath || img.dataset.fallback === '1') return;
        img.dataset.fallback = '1';
        const original = urls[photoPath];
        if (original && original !== img.src) {
          img.src = original;
          return;
        }
        void signOnePhotoUrl(client, photoPath).then((url) => {
          if (!url) return;
          onUrl?.(photoPath, url);
          img.src = url;
        });
      }}
    />
  );
}
