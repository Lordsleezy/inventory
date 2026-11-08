import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';

export async function fileToBase64(file: File) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export async function orderAdmin(accessToken: string, body: Record<string, unknown>) {
  const res = await fetch(floorFunctionUrl('web-order-admin'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
  return data as Record<string, unknown>;
}

export async function sessionToken(client: SupabaseClient) {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Sign in required.');
  return token;
}

/** Prefer the copy in Storage. Carrier URLs expire. */
export async function labelFileUrl(client: SupabaseClient, order: { label_storage_path?: string | null; label_url?: string | null }) {
  if (order.label_storage_path) {
    const { data, error } = await client.storage.from('order-labels').createSignedUrl(order.label_storage_path, 3600);
    if (!error && data?.signedUrl) return data.signedUrl;
  }
  return order.label_url || null;
}
