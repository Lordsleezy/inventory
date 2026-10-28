import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { UnitEditDrawer } from './UnitEditDrawer';
import { errText } from './errText';

type Photo = { id: number; path: string; is_primary: boolean };
type Detail = { unit: Record<string, unknown>; photos: Photo[] };

/** The same full unit editor used by Inventory, reachable from marketplace history. */
export function InventoryItemDialog({ client, storeId, accessToken, sku, onClose }: {
  client: SupabaseClient; storeId: string; accessToken: string; sku: string; onClose: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { data, error } = await client.rpc('portal_inventory_detail', { p_sku: sku });
        if (error) throw error;
        if (!data?.unit) throw new Error('Item no longer exists in Floor');
        const paths = (data.photos || []).map((p: Photo) => p.path);
        const signed = paths.length ? await client.storage.from('unit-photos').createSignedUrls(paths, 3600) : { data: [] };
        if (active) {
          setDetail(data as Detail);
          setUrls(Object.fromEntries((signed.data || []).filter(p => p.path && p.signedUrl).map(p => [p.path!, p.signedUrl!])));
        }
      } catch (e) { if (active) setError(errText(e)); }
    })();
    return () => { active = false; };
  }, [client, sku, refresh]);
  if (!detail) return <div className="modal-backdrop"><div className="panel modal" role="dialog" aria-label={`SKU ${sku}`}><p>{error || 'Loading item…'}</p><button onClick={onClose}>Close</button></div></div>;
  return <UnitEditDrawer client={client} storeId={storeId} accessToken={accessToken} sku={sku}
    unit={detail.unit} photos={detail.photos} urls={urls} canDelete={false} onClose={onClose}
    onSaved={unit => setDetail(d => d ? { ...d, unit } : d)}
    onPhotosChanged={() => setRefresh(n => n + 1)} onDeleted={onClose} />;
}
