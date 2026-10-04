import { Fragment, useCallback, useEffect, useState } from 'react';

const functionsBase = (import.meta.env.VITE_FLOOR_FUNCTIONS_URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');

type Log = { id: number; created_at: string; sku: string | null; trace_id: string; source: string; level: string; event: string; message: string | null; detail: unknown };
type Stalled = { trace_id: string; created_at: string; source: string; sku: string | null; action: string | null };
type SourceSummary = { source: string; errors: number; warnings: number };
type Props = { accessToken: string; stamp: (s: string) => string };

/** Everything the backend does leaves a row here: requests, background jobs, eBay pushes, and failures the browser saw. */
export function LogsPage({ accessToken, stamp }: Props) {
  const [level, setLevel] = useState<'problems' | 'error' | 'all'>('problems');
  const [source, setSource] = useState('');
  const [sku, setSku] = useState('');
  const [q, setQ] = useState('');
  const [traceId, setTraceId] = useState('');
  const [includeStarts, setIncludeStarts] = useState(false);
  const [auto, setAuto] = useState(true);
  const [logs, setLogs] = useState<Log[]>([]);
  const [summary, setSummary] = useState<SourceSummary[]>([]);
  const [stalled, setStalled] = useState<Stalled[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(true);

  const fetchLogs = useCallback(async (before?: string) => {
    const res = await fetch(`${functionsBase}/.netlify/functions/portal-logs`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list', level, source: source || undefined, sku: sku || undefined, q: q || undefined, traceId: traceId || undefined, includeStarts, limit: 80, before, light: Boolean(before) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data as { logs: Log[]; summary: SourceSummary[]; stalled: Stalled[] };
  }, [accessToken, level, source, sku, q, traceId, includeStarts]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { const d = await fetchLogs(); setLogs(d.logs); setSummary(d.summary); setStalled(d.stalled); setMore(d.logs.length >= 80); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [fetchLogs]);

  useEffect(() => { const t = setTimeout(() => { void load(); }, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { if (!auto) return; const t = setInterval(() => { void load(); }, 15000); return () => clearInterval(t); }, [auto, load]);

  async function older() {
    const last = logs[logs.length - 1]; if (!last) return;
    try { const d = await fetchLogs(last.created_at); setLogs(cur => [...cur, ...d.logs.filter(r => !cur.some(c => c.id === r.id))]); setMore(d.logs.length >= 80); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  const sources = [...new Set([...summary.map(s => s.source), ...logs.map(l => l.source)])].sort();
  const tag = (l: string) => <span className={`tag ${l === 'error' ? 'off' : l === 'warn' ? 'warn' : ''}`}>{l}</span>;

  return <>
    <header><div><div className="eyebrow">BACKEND</div><h1>Logs</h1><p>What the backend did and what went wrong: web requests, background jobs, eBay pushes, and errors the portal hit in your browser. Kept for 14 days.</p></div>
      <div className="actions"><label className="inventory-check"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />Auto-refresh</label><button className="secondary" onClick={() => void load()}>Refresh</button></div></header>
    {error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}

    {stalled.length > 0 && <section className="panel"><h2>Requests that never finished ({stalled.length})</h2>
      <p className="hint">These started and then nothing was recorded, which usually means the server timed out or was cut off. The screen that sent them showed no result.</p>
      <table className="tbl"><tbody>{stalled.map(s => <tr key={s.trace_id}><td>{stamp(s.created_at)}</td><td>{s.source}{s.action ? ` · ${s.action}` : ''}</td><td>{s.sku ? `SKU ${s.sku}` : ''}</td><td><button className="text-button" onClick={() => { setTraceId(s.trace_id); setLevel('all'); setIncludeStarts(true); }}>Show request</button></td></tr>)}</tbody></table></section>}

    {summary.length > 0 && <div className="stats">{summary.slice(0, 6).map(s => <button key={s.source} className="stat" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => { setSource(s.source); setLevel('problems'); }}><span>{s.source} · last 24 h</span><strong>{s.errors} errors{s.warnings ? ` · ${s.warnings} warnings` : ''}</strong></button>)}</div>}

    <section className="panel">
      <div className="exp-form">
        <label>Show<select value={level} onChange={e => setLevel(e.target.value as typeof level)}><option value="problems">Errors and warnings</option><option value="error">Errors only</option><option value="all">Everything</option></select></label>
        <label>Where<select value={source} onChange={e => setSource(e.target.value)}><option value="">All sources</option>{sources.map(s => <option key={s}>{s}</option>)}</select></label>
        <label>SKU<input value={sku} onChange={e => setSku(e.target.value)} placeholder="11234" /></label>
        <label>Search text<input value={q} onChange={e => setQ(e.target.value)} placeholder="MPN, timeout…" /></label>
        {traceId && <label>Request<button type="button" className="secondary" onClick={() => setTraceId('')}>{traceId.slice(0, 8)} ✕</button></label>}
        <label className="inventory-check"><input type="checkbox" checked={includeStarts} onChange={e => setIncludeStarts(e.target.checked)} />Include request starts</label>
      </div>
      {loading && logs.length === 0 ? <p className="hint">Loading…</p> : logs.length === 0 ? <div className="empty">Nothing matches. {level !== 'all' ? 'No problems found, which is good.' : ''}</div> : <table className="tbl"><thead><tr><th>Time</th><th>Level</th><th>Where</th><th>SKU</th><th>What happened</th></tr></thead><tbody>
        {logs.map(l => <Fragment key={l.id}>
          <tr onClick={() => setOpen(open === l.id ? null : l.id)} style={{ cursor: 'pointer' }}>
            <td style={{ whiteSpace: 'nowrap' }}>{stamp(l.created_at)}</td><td>{tag(l.level)}</td><td>{l.source}</td><td>{l.sku || ''}</td><td>{l.message || l.event}</td></tr>
          {open === l.id && <tr><td colSpan={5}>
            <div className="hint">Event {l.event} · request {l.trace_id} · <button className="text-button" onClick={e => { e.stopPropagation(); setTraceId(l.trace_id); setLevel('all'); setIncludeStarts(true); }}>show the whole request</button> · <button className="text-button" onClick={e => { e.stopPropagation(); void navigator.clipboard?.writeText(l.trace_id); }}>copy id</button></div>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#f4f6f9', padding: 10, borderRadius: 8, maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(l.detail, null, 2)}</pre></td></tr>}
        </Fragment>)}
      </tbody></table>}
      {more && logs.length > 0 && <div className="actions"><button className="secondary" onClick={() => void older()}>Load older</button></div>}
    </section>
  </>;
}
