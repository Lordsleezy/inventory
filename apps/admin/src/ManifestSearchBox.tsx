import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ManifestSearchLine } from './manifestReference';

const DEBOUNCE_MS = 250;

type Props = {
  client: SupabaseClient;
  onPick: (line: ManifestSearchLine) => void;
  disabled?: boolean;
};

/** Plain receive search: pick a manifest line by description / brand / UPC / item #. */
export function ManifestSearchBox({ client, onPick, disabled }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ManifestSearchLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q || disabled) {
      setResults([]);
      setBusy(false);
      setFailed(false);
      return;
    }
    const id = ++requestId.current;
    setBusy(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const { data, error } = await client.rpc('portal_search_manifest_lines', { p_q: q, p_limit: 20 });
          if (requestId.current !== id) return;
          if (error) {
            setResults([]);
            setFailed(true);
          } else {
            setResults(Array.isArray(data) ? data as ManifestSearchLine[] : []);
            setFailed(false);
          }
        } catch {
          if (requestId.current === id) {
            setResults([]);
            setFailed(true);
          }
        } finally {
          if (requestId.current === id) setBusy(false);
        }
      })();
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [client, query, disabled]);

  return (
    <div className="manifest-search-box">
      <label className="manifest-search-label">
        Search manifest
        <input
          type="search"
          value={query}
          disabled={disabled}
          placeholder="Brand, title, UPC, item #"
          autoComplete="off"
          enterKeyHint="search"
          onChange={e => setQuery(e.target.value)}
        />
      </label>
      {busy && <small className="manifest-search-status" role="status">Searching…</small>}
      {failed && <small className="manifest-search-attention" role="alert">Manifest search unavailable.</small>}
      {!busy && !failed && query.trim() && results.length === 0 && (
        <small className="manifest-search-status" role="status">No manifest lines match.</small>
      )}
      {results.length > 0 && (
        <ul className="manifest-search-results" role="listbox" aria-label="Manifest matches">
          {results.map(line => {
            const identity = [line.brand, line.description].filter(Boolean).join(' · ') || line.upc_normalized;
            const meta = [
              line.item_number ? `#${line.item_number}` : '',
              line.upc_normalized,
              line.manifest_name,
            ].filter(Boolean).join(' · ');
            return (
              <li key={`${line.manifest_id}:${line.line_number}:${line.upc_normalized}`}>
                <button
                  type="button"
                  className="manifest-search-result"
                  onClick={() => {
                    onPick(line);
                    setQuery('');
                    setResults([]);
                  }}
                >
                  <strong>{identity}</strong>
                  <span>{meta}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
