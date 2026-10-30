import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';
import { commitReceive, type ReceiveRequest } from './receiveCommit';

type Work = { sku: string; status: string; step: string; attempts: number; last_error: string | null };
export function ReceiveWorkStatus({ client, accessToken, sku }: { client: SupabaseClient; accessToken: string; sku?: string }) {
  const [rows, setRows] = useState<Work[]>([]);
  const [pending, setPending] = useState<ReceiveRequest | null>(null);
  const [recovery, setRecovery] = useState('');
  const [pendingKey, setPendingKey] = useState('');
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
      const session = await client.auth.getSession();
      let recovered: ReceiveRequest | null = null;
      // The request's staging path is store-scoped. Never display its fields or financial values.
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith('floor:pending-receive:')) continue;
        try { const saved = JSON.parse(localStorage.getItem(key) || '{}') as ReceiveRequest;
          const actor = session.data.session?.user?.id;
          if (actor && (saved.p_photos?.some(p => p.includes(`/receive/${actor}/`)) || saved.p_extras?.recovery_actor === actor) && !sku) { recovered = saved; if (alive) setPendingKey(key); }
        } catch { /* ignore unrelated device cache */ }
      }
      if (alive) setPending(recovered);
      const { data, error } = await client.rpc('receive_work_status', { p_sku: sku || null });
      if (alive && !error) setRows(data || []);
      } catch { /* status polling must not interrupt receiving or authentication changes */ }
    };
    void load(); const timer = setInterval(() => void load(), 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [client, sku]);
  async function retry(row: Work) {
    const { error } = await client.rpc('receive_retry', { p_sku: row.sku });
    if (error) return;
    setRows(previous => previous.map(r => r.sku === row.sku ? { ...r, status: 'queued', last_error: null } : r));
    void fetch(floorFunctionUrl('receive-finish'), { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => {});
  }
  async function recover() {
    if (!pending) return;
    try {
      const store = pendingKey.slice('floor:pending-receive:'.length).split(':')[0];
      const result = await commitReceive(client, store, pending);
      setRecovery(`Saved SKU ${result.skus.join(', ')}. Ready for the next scan.`); setPending(null);
      void fetch(floorFunctionUrl('receive-finish'), { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => {});
    } catch (e) { setRecovery((e as Error).message); }
  }
  return rows.length || pending || recovery ? <div className="receive-background-status" role="status">
    {pending && <p>A receive save was interrupted for {String(pending.p_fields.p_title || pending.p_fields.p_model || pending.p_request)}. Its photo and entered fields are preserved. You can receive other items. <button type="button" onClick={() => void recover()}>Recover interrupted save</button> <button type="button" onClick={() => {
      if (!window.confirm('Discard this recovery record? Uploaded photos are retained. Any item already saved on the server will not be deleted.')) return;
      localStorage.removeItem(pendingKey); setPending(null); setRecovery('Recovery record discarded. Ready for the next item.');
    }}>Discard</button></p>}
    {recovery && <p>{recovery}</p>}
    {rows.map(row => <p key={row.sku}>
    SKU {row.sku}: {row.status === 'done' ? 'Receive processing complete' : row.status === 'retry'
      ? `Needs attention: ${row.last_error || row.step}. Will retry automatically.` : `Finishing ${row.step} in background…`}
    {row.status === 'retry' && <button type="button" className="text-button" onClick={() => void retry(row)}>Retry now</button>}
  </p>)}</div> : null;
}
