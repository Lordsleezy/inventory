import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeManifestUpc } from './manifestLines';
import { manifestDefectWarnings, type ManifestReference } from './manifestReference';

/** Read-only sidecar. Never participates in catalog lookup or writes to the receive form. */
export function useManifestReceiveReference(client: SupabaseClient, upc: string) {
  const code = normalizeManifestUpc(upc);
  const [result, setResult] = useState<{ code: string; reference: ManifestReference | null; failed?: boolean } | null>(null);
  useEffect(() => {
    if (!code) return;
    let active = true;
    void (async () => {
      try {
        const { data, error } = await client.rpc('portal_manifest_receive_reference', { p_upc: code });
        if (active) setResult({ code, reference: error ? null : data, failed: !!error });
      } catch { if (active) setResult({ code, reference: null, failed: true }); }
    })();
    return () => { active = false; };
  }, [client, code]);
  return code && result?.code === code ? result : null;
}

export function ManifestReceiveReference({ result }: { result: ReturnType<typeof useManifestReceiveReference> }) {
  if (!result) return null;
  if (result.failed) return <small role="status">Manifest reference unavailable. Keep receiving or retry the scan.</small>;
  if (!result.reference) return null;
  const reference = result.reference;
  return <span className="manifest-receive-reference">
    <span style={{ display: 'block', fontWeight: 700 }} role="status">
      Manifest retail: {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(reference.retail_cents / 100)}
      <small style={{ display: 'block', fontWeight: 400 }}>from {reference.manifest_name} · {reference.manifest_on}</small>
    </span>
    {manifestDefectWarnings(reference).map((warning, i) => <span key={i} role="alert" style={{ display: 'block', color: '#b45309', background: '#fff3cd', padding: 10, borderRadius: 8, margin: '6px 0' }}>
      {warning}{reference.warnings.length > 1 ? ` (${reference.warnings[i].manifest_name})` : ''}
    </span>)}
  </span>;
}
