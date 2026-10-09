import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type ExportRow = {
  sku: string; title: string; description: string; price_cents: number; condition: string | null;
  brand: string | null; category: string | null; photo_paths: string[];
  package_weight_lb: number | null; package_length_in: number | null; package_width_in: number | null; package_height_in: number | null;
  listed_on: string[]; ebay_ok?: boolean; whatnot_ok?: boolean; depop_ok?: boolean; mercari_ok?: boolean; eligibility_notes?: string | null;
};

const csv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function saveCsv(name: string, rows: unknown[][]) {
  const text = '\uFEFF' + rows.map(r => r.map(csv).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

type Props = { client: SupabaseClient; compact?: boolean };

export function VendooExportPanel({ client, compact }: Props) {
  const [exp, setExp] = useState<ExportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refreshCount = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_vendoo_export');
    if (e) { setError(e.message); return; }
    setExp((data || []) as ExportRow[]);
  }, [client]);

  useEffect(() => { void refreshCount(); }, [refreshCount]);

  async function exportVendoo() {
    setBusy(true); setError('');
    try {
      const { data, error: e } = await client.rpc('portal_vendoo_export');
      if (e) throw e;
      const rows = (data || []) as ExportRow[];
      setExp(rows);
      const depopBlocked = rows.filter(x => x.depop_ok === false).length;
      saveCsv(`OpenBox-Vendoo-${new Date().toISOString().slice(0, 10)}.csv`, [
        ['Title', 'Description', 'Price', 'Condition', 'Brand', 'Category', 'Photo URLs', 'Weight lb', 'Length in', 'Width in', 'Height in', 'SKU', 'eBay OK', 'Whatnot OK', 'Depop OK', 'Mercari OK', 'Eligibility notes'],
        ...rows.map(x => [
          x.title,
          `${x.description.replace(/\s*SKU\s+\d{5}\s*$/i, '').trim()}\n\nSKU ${x.sku}`,
          (x.price_cents / 100).toFixed(2),
          /sealed|new/i.test(x.condition || '') && !/open|damage/i.test(x.condition || '') ? 'New' : /open|box|package/i.test(x.condition || '') ? 'New with defects / Open box' : 'Used',
          x.brand, x.category,
          x.photo_paths.map(p => `https://openboxindustries.com/media/${p.split('/').map(encodeURIComponent).join('/')}`).join(' | '),
          x.package_weight_lb, x.package_length_in, x.package_width_in, x.package_height_in, x.sku,
          x.ebay_ok ? 'YES' : 'NO', x.whatnot_ok ? 'YES' : 'NO', x.depop_ok ? 'YES' : 'NO', x.mercari_ok ? 'YES' : 'NO', x.eligibility_notes || '',
        ]),
      ]);
      setNotice(`Exported ${rows.length} items eligible on at least one Vendoo channel.${depopBlocked ? ` ${depopBlocked} are blocked on Depop.` : ''}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return <section className="panel">
    <h2>Export for Vendoo</h2>
    {!compact && <p>Exports available units with photos and prices that are not already marked Vendoo, and that are eligible on at least one of eBay / Whatnot / Depop / Mercari. CSV includes per-channel OK flags.</p>}
    {error && <div className="alert" role="alert">{error}</div>}
    {notice && <p className="hint">{notice}</p>}
    <button disabled={busy} onClick={() => void exportVendoo()}>Export for Vendoo ({exp.length} ready)</button>
    {!compact && <p className="hint">Vendoo does not document generic CSV listing import. Treat this as a listing worksheet; post through Vendoo or its browser extension.</p>}
  </section>;
}
