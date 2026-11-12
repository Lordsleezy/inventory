import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeManifestUpc } from './manifestLines';
import { manifestDefectWarnings, manifestIdentityLine, type ManifestReference } from './manifestReference';

/**
 * Manifest identity may prefill brand/title/category on a thin catalog lookup.
 * Still never writes ask or cost from the manifest.
 */
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

export function ManifestReceiveReference({ result, showMoney = true }: { result: ReturnType<typeof useManifestReceiveReference>; showMoney?: boolean }) {
  if (!result) return null;
  if (result.failed) return <small role="status">Manifest reference unavailable. Keep receiving or retry the scan.</small>;
  if (!result.reference) return null;
  const reference = result.reference;
  const identity = manifestIdentityLine(reference);
  return <span className="manifest-receive-reference">
    {identity ? <span className="manifest-receive-identity" role="status">{identity}</span> : null}
    {showMoney && reference.retail_cents != null && <span style={{ display: 'block', fontWeight: 700 }} role="status">
      Manifest retail: {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(reference.retail_cents / 100)}
      <small style={{ display: 'block', fontWeight: 400 }}>from {reference.manifest_name} · {reference.manifest_on}</small>
    </span>}
    {reference.expected != null && <small style={{display:'block'}}>{reference.received || 0} of {reference.expected} received for this UPC</small>}
    {manifestDefectWarnings(reference).map((warning, i) => <span key={i} role="alert" style={{ display: 'block', color: '#e5484d', padding: '6px 0' }}>
      {warning}{reference.warnings.length > 1 ? ` (${reference.warnings[i].manifest_name})` : ''}
    </span>)}
  </span>;
}
