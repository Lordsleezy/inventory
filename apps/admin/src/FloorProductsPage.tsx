import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';

type Product = {
  gtin14: string;
  upc_a?: string | null;
  brand?: string | null;
  model?: string | null;
  title?: string | null;
  category?: string | null;
  package_length_in?: number | null;
  package_width_in?: number | null;
  package_height_in?: number | null;
  package_weight_lb?: number | null;
  source?: string | null;
  updated_at?: string | null;
};

type Props = { client: SupabaseClient };

/** Shared UPC product catalog — edits stick for future scans across stores. */
export function FloorProductsPage({ client }: Props) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Product[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Product | null>(null);

  async function search(query = q) {
    setBusy(true);
    setError('');
    try {
      const { data, error: e } = await client.rpc('portal_floor_products_search', {
        p_q: query,
        p_limit: 50,
      });
      if (e) throw e;
      setRows(Array.isArray(data) ? (data as Product[]) : []);
    } catch (err) {
      setError(errText(err));
      setRows([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void search('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  async function save() {
    if (!edit?.gtin14) return;
    setBusy(true);
    setError('');
    try {
      const title = [edit.brand, edit.model].filter(Boolean).join(' ').trim() || edit.title || '';
      const { error: e } = await client.rpc('portal_floor_product_upsert', {
        p_product: {
          gtin14: edit.gtin14,
          upc_a: edit.upc_a || null,
          brand: edit.brand || null,
          model: edit.model || null,
          title,
          category: edit.category || null,
          package_length_in: edit.package_length_in ?? null,
          package_width_in: edit.package_width_in ?? null,
          package_height_in: edit.package_height_in ?? null,
          package_weight_lb: edit.package_weight_lb ?? null,
          source: 'manual',
        },
      });
      if (e) throw e;
      setEdit(null);
      await search();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Product database</h2>
      <p className="hint">
        Shared UPC catalog used before Amazon/UPCitemdb. Price, condition, cost, and SKU stay on each unit — not here.
        Title is brand + item specifics.
        {' '}
        <a href="/?page=inventory&inventoryTab=measure-mat">Print measure mat</a>
        {' '}for photo dimension scale.
      </p>
      <div className="actions">
        <label>
          Search UPC or name
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void search();
              }
            }}
          />
        </label>
        <button type="button" className="secondary" disabled={busy} onClick={() => void search()}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
      {!rows.length && !busy && <p className="empty">No saved products yet. Successful scans and photo IDs fill this list.</p>}
      <ul className="unit-list">
        {rows.map((r) => (
          <li key={r.gtin14}>
            <button type="button" className="text-button" onClick={() => setEdit({ ...r })}>
              <strong>{r.title || [r.brand, r.model].filter(Boolean).join(' ') || r.gtin14}</strong>
              <span className="muted">
                {' '}
                · {r.upc_a || r.gtin14}
                {r.source ? ` · ${r.source}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {edit && (
        <div className="receive-modal" role="dialog" aria-modal="true">
          <div className="receive-modal-card">
            <h3>Edit product</h3>
            <label>
              GTIN-14
              <input value={edit.gtin14} disabled />
            </label>
            <label>
              Brand
              <input
                value={edit.brand || ''}
                onChange={(e) => setEdit({ ...edit, brand: e.target.value })}
              />
            </label>
            <label>
              Item specifics
              <input
                value={edit.model || ''}
                onChange={(e) => setEdit({ ...edit, model: e.target.value })}
                placeholder="e.g. Replacement Brush Heads 10 Pack"
              />
            </label>
            <p className="hint">
              Title will be: {[edit.brand, edit.model].filter(Boolean).join(' ') || '—'}
            </p>
            <label>
              Category
              <input
                value={edit.category || ''}
                onChange={(e) => setEdit({ ...edit, category: e.target.value })}
              />
            </label>
            <div className="unit-edit-grid">
              <label>
                L (in)
                <input
                  inputMode="decimal"
                  value={edit.package_length_in ?? ''}
                  onChange={(e) =>
                    setEdit({ ...edit, package_length_in: e.target.value ? Number(e.target.value) : null })
                  }
                />
              </label>
              <label>
                W (in)
                <input
                  inputMode="decimal"
                  value={edit.package_width_in ?? ''}
                  onChange={(e) =>
                    setEdit({ ...edit, package_width_in: e.target.value ? Number(e.target.value) : null })
                  }
                />
              </label>
              <label>
                H (in)
                <input
                  inputMode="decimal"
                  value={edit.package_height_in ?? ''}
                  onChange={(e) =>
                    setEdit({ ...edit, package_height_in: e.target.value ? Number(e.target.value) : null })
                  }
                />
              </label>
              <label>
                Wt (lb)
                <input
                  inputMode="decimal"
                  value={edit.package_weight_lb ?? ''}
                  onChange={(e) =>
                    setEdit({ ...edit, package_weight_lb: e.target.value ? Number(e.target.value) : null })
                  }
                />
              </label>
            </div>
            <div className="actions">
              <button type="button" disabled={busy} onClick={() => void save()}>
                Save
              </button>
              <button type="button" className="secondary" onClick={() => setEdit(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
