import { useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';
import { normalizeTracking } from './trackingNormalize';

type Props = {
  client: SupabaseClient;
  disabled?: boolean;
  onDone: () => void;
};

export function PackLabelScan({ client, disabled, onDone }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  async function commit() {
    const raw = normalizeTracking(code) || '';
    if (raw.length < 8) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      const lookup = await client.rpc('portal_scan_out_lookup', { p_barcode: raw });
      const row = lookup.data as { ok?: boolean; error?: string } | null;
      if (row && row.ok === false) {
        setErr(row.error || 'Not found');
        return;
      }
      const res = await client.rpc('portal_scan_out_commit', { p_barcode: raw, p_mode: 'package' });
      const body = res.data as { ok?: boolean; error?: string; title?: string } | null;
      if (res.error) throw res.error;
      if (body?.ok === false) {
        setErr(body.error || 'Could not mark packaged');
        return;
      }
      setMsg(body?.title ? `Packaged · ${body.title}` : 'Marked packaged');
      setCode('');
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="pack-label-scan">
      <label className="receive-v2-label">Scan label to mark packaged</label>
      <input
        ref={inputRef}
        value={code}
        disabled={disabled || busy}
        onChange={e => setCode(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void commit(); } }}
        placeholder="Tracking barcode"
        autoComplete="off"
        inputMode="numeric"
      />
      {msg && <p className="hint">{msg}</p>}
      {err && <p className="receive-v2-msg">{err}</p>}
    </div>
  );
}
