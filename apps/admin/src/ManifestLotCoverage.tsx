import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

const LOT = 'TRA-7096264';

type Line = {
  line_number: number;
  upc: string;
  item_number: string;
  description: string;
  manifest_brand: string;
  alternate_upcs: string[] | null;
  catalog_title: string | null;
  catalog_brand: string | null;
  category: string | null;
  has_dims: boolean;
  has_photo: boolean;
  has_specifics: boolean;
  gtin_match: boolean;
  identity_accepted: boolean;
};

function missingOf(line: Line) {
  const missing: string[] = [];
  if (!(line.gtin_match && line.catalog_title)) missing.push('title');
  if (!(line.catalog_brand || line.manifest_brand)) missing.push('brand');
  if (!line.category) missing.push('category');
  if (!line.has_specifics) missing.push('specifics');
  if (!line.has_dims) missing.push('dims');
  if (!line.has_photo) missing.push('photo');
  return missing;
}

export function ManifestLotCoverage({ client }: { client: SupabaseClient }) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'missing' | 'review'>('missing');

  async function load() {
    const { data, error: rpcError } = await client.rpc('portal_manifest_coverage', { p_lot: LOT });
    if (rpcError) throw rpcError;
    setLines((data || []) as Line[]);
  }

  useEffect(() => {
    let active = true;
    void load().catch(e => { if (active) setError(String(e.message || e)); });
    return () => { active = false; };
  }, [client]);

  const rows = useMemo(() => (lines || []).map(line => {
    const missing = missingOf(line);
    const review = Boolean(line.catalog_title) && !line.gtin_match && !line.identity_accepted;
    const status = missing.length === 0 ? 'Fully enriched' : `Found · missing ${missing.join(', ')}`;
    return { line, missing, review, status };
  }), [lines]);
  const shown = rows.filter(row => filter === 'all' || (filter === 'missing' ? row.missing.length > 0 : row.review));
  const ready = rows.filter(row => row.missing.length === 0).length;

  if (error) return <section className="manifest-coverage"><p className="receive-scanner-error">{error}</p></section>;
  if (!lines) return <section className="manifest-coverage"><p>Loading lot {LOT}…</p></section>;
  if (!lines.length) return null;

  return (
    <section className="manifest-coverage" aria-label={`${LOT} UPC coverage`}>
      <p><strong>{LOT}</strong> · {rows.length} found · {ready} fully enriched · {rows.length - ready} still missing something</p>
      <div className="manifest-coverage-filters">
        <button type="button" onClick={() => setFilter('all')}>All</button>
        <button type="button" onClick={() => setFilter('missing')}>Missing</button>
        <button type="button" onClick={() => setFilter('review')}>Review</button>
      </div>
      <ul>
        {shown.map(({ line, review, status }) => (
          <li key={line.line_number}>
            <strong>{line.description || 'Untitled'}</strong>
            <span>{line.upc} · item {line.item_number || '—'}</span>
            <span className={status.startsWith('Found ·') ? 'is-missing' : ''}>{status}</span>
            {line.alternate_upcs?.length ? <span>Also {line.alternate_upcs.join(', ')}</span> : null}
            {review && <button type="button" onClick={() => void client.rpc('portal_manifest_accept_identity', { p_lot: LOT, p_item: line.item_number || line.upc }).then(() => load())}>Keep manifest name</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}
