import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';
type PeerResult = { ok?: boolean; shipped?: number; skus?: string[]; left_unpackaged?: string[]; error?: string };

/** After one verified scan, ship the rest of the box. The tracking number is not shown. */
export async function shipBundleRest(client: SupabaseClient, leadId: string, barcode: string): Promise<string> {
  const code = barcode.trim();
  if (!leadId || !code) return '';
  const { data, error } = await client.rpc('portal_bundle_ship_peers', { p_order: leadId, p_barcode: code });
  if (error) return '';
  const body = (data || {}) as PeerResult;
  const skus = body.skus || [];
  const left = body.left_unpackaged || [];
  if (skus.length) {
    const { data: session } = await client.auth.getSession();
    const token = session.session?.access_token;
    if (token) {
      await fetch(floorFunctionUrl('bundle-apply'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'tracking', order_id: leadId }),
      }).catch(() => null);
    }
  }
  const parts = [];
  if (skus.length) parts.push(`Also shipped ${skus.join(', ')} in the same box.`);
  if (left.length) parts.push(`Still in To ship: ${left.join(', ')}.`);
  return parts.join(' ');
}
