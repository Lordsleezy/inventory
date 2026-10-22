import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isKioskShell, scannerInputMode } from './kiosk';
import { floorFunctionUrl } from './floorApi';
import { reportClientError } from './clientLog';
import { errText } from './errText';

const money = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n / 100);

type FieldKey = 'title' | 'brand' | 'model' | 'price' | 'description' | 'package' | 'images' | 'asin';

type SourceBlock = {
  found?: boolean;
  skipped?: string;
  asin?: string | null;
  title?: string | null;
  brand?: string | null;
  model?: string | null;
  description?: string | null;
  features?: string[];
  package?: { length_in?: number | null; width_in?: number | null; height_in?: number | null; weight_lb?: number | null };
  images?: string[];
  price_cents?: number | null;
  price_source?: string | null;
  category?: string | null;
  raw_error?: string | null;
  price_error?: string | null;
};

type LookupResult = {
  gtin?: { gtin14?: string; upcA?: string; ean13?: string };
  cached?: boolean;
  amazon?: SourceBlock;
  upcitemdb?: SourceBlock;
  ebay?: { found?: boolean; sold_comps?: { title?: string; price_cents?: number; condition?: string }[] } | null;
  merged?: Record<string, unknown> & { disagreements?: { field: string; amazon?: string; upcitemdb?: string }[] };
  fieldCoverage?: Partial<Record<FieldKey, string | null>>;
  error?: string;
};

type Row = {
  id: string;
  scanned: string;
  at: string;
  ok: boolean;
  error?: string;
  result?: LookupResult;
};

const FIELDS: { key: FieldKey; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'brand', label: 'Brand' },
  { key: 'model', label: 'Model' },
  { key: 'price', label: 'Current price' },
  { key: 'description', label: 'Description / features' },
  { key: 'package', label: 'Package dims + weight' },
  { key: 'images', label: 'Images' },
  { key: 'asin', label: 'ASIN' },
];

function pkgText(p?: SourceBlock['package']) {
  if (!p) return null;
  const dims = [p.length_in, p.width_in, p.height_in].filter((n) => n != null && Number(n) > 0);
  const w = p.weight_lb != null && Number(p.weight_lb) > 0 ? `${p.weight_lb} lb` : null;
  if (!dims.length && !w) return null;
  const dim = dims.length === 3 ? `${dims[0]}×${dims[1]}×${dims[2]} in` : null;
  return [dim, w].filter(Boolean).join(' · ');
}

function sourceHas(block: SourceBlock | undefined, key: FieldKey): boolean {
  if (!block?.found) return false;
  if (key === 'title') return !!block.title;
  if (key === 'brand') return !!block.brand;
  if (key === 'model') return !!block.model;
  if (key === 'price') return (block.price_cents ?? 0) > 0;
  if (key === 'description') return !!(block.description || (block.features && block.features.length));
  if (key === 'package') return !!pkgText(block.package);
  if (key === 'images') return !!(block.images && block.images.length);
  if (key === 'asin') return !!block.asin;
  return false;
}

async function lookupCall(token: string, upc: string, force = false, compare = true): Promise<LookupResult> {
  const run = async () => {
    const res = await fetch(floorFunctionUrl('upc-lookup'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'lookup', upc, force, compare_upcitemdb: compare }),
    });
    const json = await res.json().catch(() => ({} as { error?: string; message?: string }));
    if (!res.ok) {
      const msg = json.error || json.message || `Lookup failed (${res.status})`;
      if (res.status === 401) throw new Error('Not logged in — sign in again.');
      if (/failed to fetch/i.test(msg)) throw new Error("Couldn't reach the lookup server.");
      throw new Error(msg);
    }
    return json as LookupResult;
  };
  try {
    return await run();
  } catch (e) {
    const msg = errText(e);
    if (/not logged in|invalid/i.test(msg)) throw e;
    await new Promise((r) => setTimeout(r, 600));
    try {
      return await run();
    } catch (e2) {
      reportClientError(token, { message: `upc_lookup failed: ${e2 instanceof Error ? e2.message : String(e2)}`, page: 'lookup-test', action_name: 'upc_lookup', sku: upc });
      throw e2;
    }
  }
}

type Props = { accessToken: string };

export function LookupTestPage({ accessToken }: Props) {
  const [draft, setDraft] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [compareBoth, setCompareBoth] = useState(true);
  const [force, setForce] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const totals = useMemo(() => {
    const ok = rows.filter((r) => r.ok && r.result);
    const init = Object.fromEntries(FIELDS.map((f) => [f.key, { amazon: 0, upcitemdb: 0, neither: 0, either: 0 }])) as Record<
      FieldKey,
      { amazon: number; upcitemdb: number; neither: number; either: number }
    >;
    for (const r of ok) {
      const a = r.result?.amazon;
      const u = r.result?.upcitemdb;
      for (const { key } of FIELDS) {
        const ha = sourceHas(a, key);
        const hu = sourceHas(u, key);
        if (ha) init[key].amazon++;
        if (hu) init[key].upcitemdb++;
        if (ha || hu) init[key].either++;
        else init[key].neither++;
      }
    }
    return { n: ok.length, fields: init };
  }, [rows]);

  const enqueue = useCallback(
    (raw: string) => {
      const scanned = raw.trim();
      if (!scanned) return;
      setDraft('');
      setError('');
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setRows((prev) => [{ id, scanned, at: new Date().toISOString(), ok: false }, ...prev]);
      setBusy(true);
      queueRef.current = queueRef.current
        .then(async () => {
          try {
            const result = await lookupCall(accessToken, scanned, force, compareBoth);
            setRows((prev) =>
              prev.map((r) => (r.id === id ? { ...r, ok: true, result } : r)),
            );
          } catch (e) {
            const msg = errText(e);
            setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ok: false, error: msg } : r)));
            setError(msg);
          }
        })
        .finally(() => {
          setBusy(false);
          requestAnimationFrame(() => inputRef.current?.focus());
        });
    },
    [accessToken, force, compareBoth],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    enqueue(draft);
  }

  function exportCsv() {
    const header = ['upc', 'gtin14', 'cached', 'asin', ...FIELDS.map((f) => `amazon_${f.key}`), ...FIELDS.map((f) => `upcitemdb_${f.key}`), 'disagreements'];
    const lines = [header.join(',')];
    for (const r of rows) {
      if (!r.result) continue;
      const a = r.result.amazon;
      const u = r.result.upcitemdb;
      const cells = [
        r.scanned,
        r.result.gtin?.gtin14 || '',
        r.result.cached ? '1' : '0',
        a?.asin || '',
        ...FIELDS.map((f) => (sourceHas(a, f.key) ? '1' : '0')),
        ...FIELDS.map((f) => (sourceHas(u, f.key) ? '1' : '0')),
        JSON.stringify(r.result.merged?.disagreements || []).replace(/"/g, '""'),
      ];
      lines.push(cells.map((c) => `"${c}"`).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const aEl = document.createElement('a');
    aEl.href = url;
    aEl.download = `upc-lookup-test-${new Date().toISOString().slice(0, 10)}.csv`;
    aEl.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="panel">
      <div className="section-head" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="eyebrow">ACCURACY TEST · READ ONLY</div>
          <h2>Lookup test</h2>
          <p className="hint" style={{ margin: 0 }}>
            Scan ~30 UPCs. Nothing is written to inventory. Compare Amazon vs UPCitemdb field coverage to decide if a paid UPC DB is worth it.
            Plug another source later via the upc-lookup function.
          </p>
        </div>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => setRows([])} disabled={!rows.length}>Clear</button>
          <button type="button" className="secondary" onClick={exportCsv} disabled={!rows.some((r) => r.result)}>Export CSV</button>
        </div>
      </div>

      <div className="inventory-controls" style={{ marginBottom: 12 }}>
        <label className="receive-upc" style={{ flex: 1, minWidth: 220 }}>
          Scan UPC
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
            inputMode={scannerInputMode() === 'none' ? 'none' : 'numeric'}
            autoComplete="off"
            enterKeyHint="done"
            placeholder={isKioskShell() ? 'Scan barcode' : 'Scan or type · Enter'}
            disabled={!accessToken}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={compareBoth} onChange={(e) => setCompareBoth(e.target.checked)} />
          Always hit UPCitemdb (even if Amazon complete)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          Bypass cache
        </label>
        <button type="button" disabled={busy || !draft.trim()} onClick={() => enqueue(draft)}>
          {busy ? 'Looking up…' : 'Lookup'}
        </button>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}

      {totals.n > 0 && (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Amazon</th>
                <th>UPCitemdb</th>
                <th>Either</th>
                <th>Neither</th>
              </tr>
            </thead>
            <tbody>
              {FIELDS.map((f) => {
                const t = totals.fields[f.key];
                const pct = (n: number) => `${n}/${totals.n} (${Math.round((n / totals.n) * 100)}%)`;
                return (
                  <tr key={f.key}>
                    <td><strong>{f.label}</strong></td>
                    <td>{pct(t.amazon)}</td>
                    <td>{pct(t.upcitemdb)}</td>
                    <td>{pct(t.either)}</td>
                    <td>{pct(t.neither)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="hint">{totals.n} completed lookup{totals.n === 1 ? '' : 's'} · cached hits still count toward coverage</p>
        </div>
      )}

      <div className="ticket-list">
        {rows.length === 0 && <div className="empty">No scans yet. Focus the box and scan a UPC.</div>}
        {rows.map((r) => (
          <LookupRow key={r.id} row={r} />
        ))}
      </div>
    </section>
  );
}

function LookupRow({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const r = row.result;
  const a = r?.amazon;
  const u = r?.upcitemdb;
  return (
    <div className={`ticket${open ? ' ticket-open' : ''}`}>
      <button type="button" className="ticket-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <div className="ticket-top">
          <strong>{row.scanned}{r?.gtin?.upcA && r.gtin.upcA !== row.scanned ? <small> → {r.gtin.upcA}</small> : null}</strong>
          <span>
            {row.ok ? (r?.cached ? 'cached' : 'live') : row.error ? 'error' : '…'}
            {a?.asin ? ` · ${a.asin}` : ''}
            <span className="ticket-chevron" aria-hidden>{open ? '▴' : '▾'}</span>
          </span>
        </div>
        <div className="ticket-bottom">
          <span>{a?.title || u?.title || row.error || 'Looking up…'}</span>
          <span>{a?.price_cents ? money(a.price_cents) : u?.price_cents ? money(u.price_cents) : '—'}</span>
        </div>
      </button>
      {open && (
        <div className="ticket-detail">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Field</th><th>Amazon</th><th>UPCitemdb</th></tr>
              </thead>
              <tbody>
                {FIELDS.map((f) => (
                  <tr key={f.key}>
                    <td>{f.label}</td>
                    <td>{fieldCell(a, f.key)}</td>
                    <td>{fieldCell(u, f.key)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!!r?.merged?.disagreements?.length && (
            <p className="hint" role="status">
              Disagreements: {r.merged.disagreements.map((d) => `${d.field}`).join(', ')}
            </p>
          )}
          {a?.raw_error && <p className="error">Amazon: {a.raw_error}</p>}
          {a?.price_error && <p className="hint">Amazon price: {a.price_error}</p>}
          {u?.skipped && <p className="hint">UPCitemdb skipped: {u.skipped}</p>}
          {r?.ebay?.found && (
            <p className="hint">eBay sold comps: {(r.ebay.sold_comps || []).slice(0, 3).map((c) => `${c.title?.slice(0, 40)} ${money(c.price_cents)}`).join(' · ') || 'none'}</p>
          )}
        </div>
      )}
    </div>
  );
}

function fieldCell(block: SourceBlock | undefined, key: FieldKey) {
  if (!block?.found && !block?.skipped) return '—';
  if (!sourceHas(block, key)) return <span className="hint">miss</span>;
  if (key === 'title') return block.title;
  if (key === 'brand') return block.brand;
  if (key === 'model') return block.model;
  if (key === 'price') return `${money(block.price_cents)}${block.price_source ? ` (${block.price_source})` : ''}`;
  if (key === 'description') return block.description?.slice(0, 120) || `${block.features?.length || 0} bullets`;
  if (key === 'package') return pkgText(block.package);
  if (key === 'images') return `${block.images?.length || 0} img`;
  if (key === 'asin') return block.asin;
  return '✓';
}
