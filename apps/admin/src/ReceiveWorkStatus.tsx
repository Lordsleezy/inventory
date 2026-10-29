import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';
import { commitReceive, type ReceiveRequest } from './receiveCommit';
import { receiveRecoveryRecords, type RecoveryRecord } from './receiveRecovery';
import { receivePhotoIdentity } from '../../../shared/store-barcode.mjs';

type Work = { sku: string; status: string; step: string; attempts: number; last_error: string | null };
export function ReceiveWorkStatus({ client, accessToken, sku, storeId }: { client: SupabaseClient; accessToken: string; sku?: string; storeId?: string }) {
  const [rows, setRows] = useState<Work[]>([]);
  const [records, setRecords] = useState<RecoveryRecord[]>([]);
  const [recovery, setRecovery] = useState('');
  const [recovering, setRecovering] = useState(false);
  const dismissed = useRef(new Set<string>());
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const session = await client.auth.getSession();
        const actor = session.data.session?.user?.id;
        if (alive && actor && storeId && !sku) setRecords(receiveRecoveryRecords(localStorage, storeId, actor).filter(record => !dismissed.current.has(record.key)));
        const { data, error } = await client.rpc('receive_work_status', { p_sku: sku || null });
        if (alive && !error) setRows(data || []);
      } catch { /* Status/recovery must not interrupt receiving. */ }
    };
    void load(); const timer = setInterval(() => void load(), 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [client, sku, storeId]);
  function leave(key: string, discard = false) {
    if (discard) {
      try { localStorage.removeItem(key); } catch { setRecovery('Could not discard this device record. You can still cancel and receive other items.'); }
    }
    dismissed.current.add(key); setRecords(previous => previous.filter(record => record.key !== key));
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-receive-scan]:not(:disabled)')?.focus());
  }
  function edit(record: RecoveryRecord, change: (request: ReceiveRequest) => ReceiveRequest) {
    if (!record.request) return;
    const next = change(record.request);
    try {
      localStorage.setItem(record.key, JSON.stringify(next));
      setRecords(previous => previous.map(row => row.key === record.key ? { ...row, request: next } : row));
    } catch { setRecovery('Device storage is unavailable. Cancel recovery to receive another item; this record is preserved.'); }
  }
  async function recover(record: RecoveryRecord) {
    if (!record.request || !storeId || recovering) return;
    setRecovering(true); setRecovery('');
    try {
      const result = await commitReceive(client, storeId, record.request);
      setRecovery(`Saved SKU ${result.skus.join(', ')}. Ready for the next scan.`); leave(record.key);
      void fetch(floorFunctionUrl('receive-finish'), { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => {});
    } catch (error) { setRecovery((error as Error).message); }
    finally { setRecovering(false); }
  }
  async function retry(row: Work) {
    try {
      const { error } = await client.rpc('receive_retry', { p_sku: row.sku });
      if (error) { setRecovery(error.message); return; }
      setRows(previous => previous.map(item => item.sku === row.sku ? { ...item, status: 'queued', last_error: null } : item));
      void fetch(floorFunctionUrl('receive-finish'), { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => {});
    } catch { setRecovery('Retry unavailable. You can keep receiving other items.'); }
  }
  return rows.length || records.length || recovery ? <div className="receive-background-status" role="status">
    {records.map(record => <div key={record.key} className="receive-recovery-card">
      <p>{record.request ? 'An interrupted receive was restored. Edit or retry it, or keep receiving other items.' : 'An unreadable device draft was found. It will not block Receive.'} Discard removes only the device record; uploaded photos and any saved SKU stay intact.</p>
      <div className="receive-escape-actions"><button type="button" onClick={() => leave(record.key)}>Cancel recovery — scan next</button><button type="button" onClick={() => leave(record.key, true)}>Discard</button></div>
      {record.request && <>
        <label>Recovery item title<textarea rows={2} value={String(record.request.p_fields.p_title || '')} onChange={event => edit(record, request => ({ ...request, p_fields: { ...request.p_fields, p_title: event.target.value } }))} /></label>
        <label>Recovery brand<input value={String(record.request.p_fields.p_brand || '')} onChange={event => edit(record, request => ({ ...request, p_fields: { ...request.p_fields, p_brand: event.target.value } }))} /></label>
        <button type="button" onClick={() => edit(record, request => {
          const identity = receivePhotoIdentity({ title: request.p_fields.p_title, brand: 'Unbranded' });
          return { ...request, p_fields: { ...request.p_fields, p_brand: 'Unbranded' }, p_extras: { ...request.p_extras,
            photo_identity_type: request.p_extras.photo_identity_type || identity.item_type } };
        })}>No brand</button>
        <button type="button" onClick={() => edit(record, request => ({ ...request, p_extras: { ...request.p_extras, photo_identity_confirmed: false, photo_identity_type: '' } }))}>Enter details myself</button>
        <button type="button" disabled={recovering} onClick={() => void recover(record)}>Recover interrupted save</button>
      </>}
    </div>)}
    {recovery && <p>{recovery}<button type="button" onClick={() => setRecovery('')}>Dismiss</button></p>}
    {rows.map(row => <p key={row.sku}>SKU {row.sku}: {row.status === 'done' ? 'Receive processing complete' : row.status === 'retry' ? `Needs attention: ${row.last_error || row.step}. Will retry automatically.` : `Finishing ${row.step} in background…`}
      {row.status === 'retry' && <button type="button" onClick={() => void retry(row)}>Retry now</button>}
    </p>)}
  </div> : null;
}
